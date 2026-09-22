import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type RequestOptions,
  type Server,
} from "node:http";
import { describe, expect, it } from "vitest";
import type {
  DockerContainer,
  DockerContainerSpec,
  DockerExecRequest,
  DockerRuntime,
} from "@openmuse/provider-sandbox-docker";
import { createSandboxScopeToken } from "@openmuse/provider-contracts";
import { createSandboxService } from "../src/service.js";

const serviceSecret = "deadline-service-secret";
const scope = {
  workspaceId: "deadline-workspace",
  providerId: "sandbox-docker",
  instanceId: "deadline-instance",
} as const;
const image = "alpine@sha256:" + "a".repeat(64);
const deadlineMs = 1_000;

type Inspection = Awaited<ReturnType<DockerContainer["inspect"]>>;

class BasicContainer implements DockerContainer {
  readonly id = "0123456789ab";
  readonly labels = {
    "openmuse.workspace_id": scope.workspaceId,
    "openmuse.provider": scope.providerId,
    "openmuse.instance_id": scope.instanceId,
    "openmuse.user_id": "",
  };

  async inspect(): Promise<Inspection> {
    return { status: "running", image, labels: this.labels };
  }

  async exec(request: DockerExecRequest) {
    return {
      exitCode: 0,
      stdout: request.argv.join(" "),
      stderr: "",
      timedOut: false,
      providerOperationId: request.operationId,
    };
  }

  async readFile(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async writeFile(): Promise<void> {}

  async destroy(): Promise<void> {}
}

class HangingInspectContainer extends BasicContainer {
  inspectSignal?: AbortSignal;

  async inspect(...args: unknown[]): Promise<Inspection> {
    this.inspectSignal = args[0] as AbortSignal | undefined;
    return new Promise<Inspection>((_resolve, reject) => {
      const signal = this.inspectSignal;
      if (!signal) return;
      const onAbort = () => reject(new Error("inspect aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

class TestRuntime implements DockerRuntime {
  constructor(readonly container: BasicContainer) {}

  async create(_spec: DockerContainerSpec): Promise<DockerContainer> {
    return this.container;
  }

  async get(_id: string, _signal: AbortSignal): Promise<DockerContainer> {
    return this.container;
  }
}

async function token(): Promise<string> {
  return createSandboxScopeToken(serviceSecret, {
    ...scope,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  });
}

function serviceHandler(runtime: DockerRuntime) {
  return createSandboxService({
    runtime,
    serviceToken: serviceSecret,
    ...scope,
    allowedImages: [image],
    maxExecSeconds: 1,
    requestTimeoutMs: deadlineMs,
  });
}

async function listen(handler: ReturnType<typeof serviceHandler>): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  if (!server.listening) return;
  await Promise.race([
    new Promise<void>((resolve) => server.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
  server.closeAllConnections?.();
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requestSettled(
  server: Server,
  handler: ReturnType<typeof serviceHandler>,
  target: URL,
  options: RequestOptions,
  body?: string,
): { request: ClientRequest; settled: Promise<boolean>; socketClosed: Promise<boolean> } {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let socketClose!: () => void;
  const socketClosed = new Promise<void>((resolve) => {
    socketClose = resolve;
  });
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    void handler(request, response)
      .catch(() => undefined)
      .finally(() => settle());
  });
  const request = httpRequest(target, options, (response) => {
    response.resume();
  });
  request.on("error", () => undefined);
  request.on("socket", (socket) => {
    socket.once("close", socketClose);
  });
  if (body === undefined) request.end();
  else request.write(body);
  return {
    request,
    settled: Promise.race([settled.then(() => true), wait(deadlineMs + 500).then(() => false)]),
    socketClosed: Promise.race([
      socketClosed.then(() => true),
      wait(deadlineMs + 500).then(() => false),
    ]),
  };
}

describe("sandbox service deadlines", () => {
  it("settles and closes a request whose JSON body stops partway through", async () => {
    const runtime = new TestRuntime(new BasicContainer());
    const handler = serviceHandler(runtime);
    const { server, url } = await listen(handler);
    const request = requestSettled(
      server,
      handler,
      new URL(`${url}/v1/sandboxes`),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await token()}`,
          "Content-Type": "application/json",
          "Content-Length": "1000000",
        },
      },
      "{",
    );
    try {
      expect(await request.settled).toBe(true);
      expect(await request.socketClosed).toBe(true);
    } finally {
      request.request.destroy();
      await closeServer(server);
    }
  }, 5_000);

  it("cancels a container inspection when the request deadline expires", async () => {
    const container = new HangingInspectContainer();
    const handler = serviceHandler(new TestRuntime(container));
    const { server, url } = await listen(handler);
    const request = requestSettled(
      server,
      handler,
      new URL(`${url}/v1/sandboxes/${container.id}`),
      {
        method: "GET",
        headers: { Authorization: `Bearer ${await token()}` },
      },
    );
    try {
      expect(await request.settled).toBe(true);
      expect(container.inspectSignal).toBeDefined();
      expect(container.inspectSignal?.aborted).toBe(true);
    } finally {
      request.request.destroy();
      await closeServer(server);
    }
  }, 5_000);
});
