import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DockerContainer,
  DockerContainerSpec,
  DockerExecRequest,
  DockerRuntime,
} from "@openmuse/provider-sandbox-docker";
import { DockerUnknownOutcomeError } from "@openmuse/provider-sandbox-docker";
import { createSandboxScopeToken } from "@openmuse/provider-contracts";
import { createSandboxService } from "../src/service.js";

const serviceSecret = "service-secret";
const scope = {
  workspaceId: "workspace-1",
  providerId: "sandbox-docker",
  instanceId: "service-test-instance",
} as const;
const image = "alpine@sha256:" + "a".repeat(64);

class FakeContainer implements DockerContainer {
  readonly id = "0123456789ab";
  readonly bytes = new Uint8Array([1, 2, 3]);
  readonly labels = {
    "openmuse.workspace_id": "workspace-1",
    "openmuse.provider": "sandbox-docker",
    "openmuse.instance_id": "service-test-instance",
    "openmuse.user_id": "",
  };
  destroyed = false;
  lastExec?: DockerExecRequest;
  destroyError?: Error;
  async inspect() {
    return {
      status: "running" as const,
      image: "alpine@sha256:" + "a".repeat(64),
      labels: this.labels,
    };
  }
  async exec(request: DockerExecRequest) {
    this.lastExec = request;
    return {
      exitCode: 0,
      stdout: request.argv.join(" "),
      stderr: "",
      timedOut: false,
      providerOperationId: request.operationId,
    };
  }
  async readFile() {
    return this.bytes;
  }
  async writeFile(file: { bytes: Uint8Array }) {
    this.bytes.set(file.bytes);
  }
  async cancel() {}
  async destroy() {
    if (this.destroyError) throw this.destroyError;
    this.destroyed = true;
  }
}

class FakeRuntime implements DockerRuntime {
  readonly container = new FakeContainer();
  async create(_spec: DockerContainerSpec) {
    return this.container;
  }
  async get() {
    return this.container;
  }
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function start(
  runtime: DockerRuntime,
  overrides: Partial<Parameters<typeof createSandboxService>[0]> = {},
): Promise<{
  url: string;
  token: string;
  otherWorkspaceToken: string;
  otherInstanceToken: string;
  otherActorToken: string;
}> {
  const token = await createSandboxScopeToken(serviceSecret, {
    ...scope,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  });
  const otherWorkspaceToken = await createSandboxScopeToken(serviceSecret, {
    ...scope,
    workspaceId: "workspace-2",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  });
  const otherInstanceToken = await createSandboxScopeToken(serviceSecret, {
    ...scope,
    instanceId: "other-instance",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  });
  const otherActorToken = await createSandboxScopeToken(serviceSecret, {
    ...scope,
    userId: "actor-2",
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  });
  const server = createServer(
    (request, response) =>
      void createSandboxService({
        runtime,
        serviceToken: serviceSecret,
        ...scope,
        allowedImages: [image],
        ...overrides,
      })(request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    otherWorkspaceToken,
    otherInstanceToken,
    otherActorToken,
  };
}

describe("sandbox service", () => {
  it("requires service authentication and enforces workspace/provider ownership", async () => {
    const runtime = new FakeRuntime();
    const service = await start(runtime);
    await expect(
      fetch(`${service.url}/v1/sandboxes/${runtime.container.id}`),
    ).resolves.toMatchObject({ status: 401 });
    const headers = {
      Authorization: `Bearer ${service.token}`,
      "X-OpenMuse-Workspace": "workspace-2",
    };
    await expect(
      fetch(`${service.url}/v1/sandboxes/${runtime.container.id}`, { headers }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      fetch(`${service.url}/v1/sandboxes/${runtime.container.id}`, {
        headers: { Authorization: `Bearer ${service.otherWorkspaceToken}` },
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      fetch(`${service.url}/v1/sandboxes/${runtime.container.id}`, {
        headers: { Authorization: `Bearer ${service.otherInstanceToken}` },
      }),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      fetch(`${service.url}/v1/sandboxes/${runtime.container.id}`, {
        headers: { Authorization: `Bearer ${service.otherActorToken}` },
      }),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("exposes only the bounded sandbox JSON operations", async () => {
    const runtime = new FakeRuntime();
    const service = await start(runtime, { maxFileBytes: 3 });
    const headers = {
      Authorization: `Bearer ${service.token}`,
      "Content-Type": "application/json",
    };
    const operationId = "operation/1 with spaces";
    const exec = await fetch(`${service.url}/v1/sandboxes/${runtime.container.id}/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ argv: ["echo", "ok"], operationId }),
    });
    expect(exec.status).toBe(200);
    expect(await exec.json()).toMatchObject({
      stdout: "echo ok",
      providerOperationId: operationId,
    });
    const read = await fetch(`${service.url}/v1/sandboxes/${runtime.container.id}/files/read`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "/workspace/file" }),
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ bytesBase64: "AQID" });
    const oversized = await fetch(
      `${service.url}/v1/sandboxes/${runtime.container.id}/files/write`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "/workspace/file", bytesBase64: "AAAAAA==" }),
      },
    );
    expect(oversized.status).toBe(413);
    const removed = await fetch(`${service.url}/v1/sandboxes/${runtime.container.id}`, {
      method: "DELETE",
      headers,
    });
    expect(removed.status).toBe(204);
    expect(runtime.container.destroyed).toBe(true);
  });

  it("decodes operation routes and validates finite request limits", async () => {
    const runtime = new FakeRuntime();
    const service = await start(runtime, { maxFileBytes: 3, maxExecSeconds: 5 });
    const headers = {
      Authorization: `Bearer ${service.token}`,
      "Content-Type": "application/json",
    };
    const invalidExec = await fetch(`${service.url}/v1/sandboxes/${runtime.container.id}/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ argv: ["echo", "ok"], operationId: "op", timeoutSeconds: Infinity }),
    });
    // JSON cannot represent Infinity, so the request is rejected before it can
    // reach the provider with a non-finite timeout.
    expect(invalidExec.status).toBe(400);
    const validExec = await fetch(`${service.url}/v1/sandboxes/${runtime.container.id}/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ argv: ["echo", "ok"], operationId: "op-valid", timeoutSeconds: 4 }),
    });
    expect(validExec.status).toBe(200);
    expect(runtime.container.lastExec?.timeoutSeconds).toBe(4);
    const overLimitExec = await fetch(`${service.url}/v1/sandboxes/${runtime.container.id}/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ argv: ["echo", "ok"], operationId: "op-over", timeoutSeconds: 6 }),
    });
    expect(overLimitExec.status).toBe(400);
    const cancelled = await fetch(
      `${service.url}/v1/sandboxes/${runtime.container.id}/operations/${encodeURIComponent("op/1")}/cancel`,
      { method: "POST", headers },
    );
    expect(cancelled.status).toBe(204);
  });

  it("propagates cleanup uncertainty without exposing internal errors", async () => {
    const runtime = new FakeRuntime();
    const service = await start(runtime);
    runtime.container.destroyError = new DockerUnknownOutcomeError("docker details are private");
    const response = await fetch(`${service.url}/v1/sandboxes/${runtime.container.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${service.token}` },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Sandbox service operation failed.",
      code: "unknown_outcome",
    });
  });
});
