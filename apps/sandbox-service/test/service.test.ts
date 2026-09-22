import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DockerContainer,
  DockerContainerSpec,
  DockerExecRequest,
  DockerRuntime,
} from "@openmuse/provider-sandbox-docker";
import { createSandboxService } from "../src/service.js";

class FakeContainer implements DockerContainer {
  readonly id = "0123456789ab";
  readonly bytes = new Uint8Array([1, 2, 3]);
  readonly labels = {
    "openmuse.workspace_id": "workspace-1",
    "openmuse.provider": "sandbox-docker",
  };
  destroyed = false;
  async inspect() {
    return {
      status: "running" as const,
      image: "alpine@sha256:" + "a".repeat(64),
      labels: this.labels,
    };
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
  async readFile() {
    return this.bytes;
  }
  async writeFile(file: { bytes: Uint8Array }) {
    this.bytes.set(file.bytes);
  }
  async cancel() {}
  async destroy() {
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

async function start(runtime: DockerRuntime): Promise<{ url: string; token: string }> {
  const token = "service-secret";
  const server = createServer(
    (request, response) =>
      void createSandboxService({ runtime, serviceToken: token })(request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { url: `http://127.0.0.1:${address.port}`, token };
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
    ).resolves.toMatchObject({ status: 403 });
  });

  it("exposes only the bounded sandbox JSON operations", async () => {
    const runtime = new FakeRuntime();
    const service = await start(runtime);
    const headers = {
      Authorization: `Bearer ${service.token}`,
      "X-OpenMuse-Workspace": "workspace-1",
      "Content-Type": "application/json",
    };
    const operationId = "operation-1";
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
    const removed = await fetch(`${service.url}/v1/sandboxes/${runtime.container.id}`, {
      method: "DELETE",
      headers,
    });
    expect(removed.status).toBe(204);
    expect(runtime.container.destroyed).toBe(true);
  });
});
