import { describe, expect, it } from "vitest";
import type { ProviderOperationContext, SandboxCreateRequest } from "@openmuse/provider-contracts";
import {
  createDockerSandboxDriver,
  type DockerContainer,
  type DockerContainerSpec,
  type DockerRuntime,
} from "../src/index.js";

function operation(workspaceId = "workspace-1"): ProviderOperationContext {
  return { signal: new AbortController().signal, operationId: crypto.randomUUID(), workspaceId };
}

class FakeContainer implements DockerContainer {
  readonly id = "container-1";
  destroyed = false;
  lastSpec?: DockerContainerSpec;
  async inspect() {
    return {
      status: "running" as const,
      image: "node@sha256:" + "a".repeat(64),
      labels: { "openmuse.workspace_id": "workspace-1", "openmuse.provider": "sandbox-docker" },
    };
  }
  async exec(request: { argv: string[]; operationId: string; signal: AbortSignal }) {
    return {
      exitCode: 0,
      stdout: request.argv.join(" "),
      stderr: "",
      timedOut: false,
      providerOperationId: request.operationId,
    };
  }
  async readFile() {
    return new Uint8Array([1, 2, 3]);
  }
  async writeFile() {}
  async destroy() {
    this.destroyed = true;
  }
}

class FakeRuntime implements DockerRuntime {
  readonly container = new FakeContainer();
  spec?: DockerContainerSpec;
  async create(spec: DockerContainerSpec) {
    this.spec = spec;
    return this.container;
  }
  async get() {
    return this.container;
  }
}

const request: SandboxCreateRequest = {
  image: "node@sha256:" + "a".repeat(64),
};

describe("Docker sandbox provider", () => {
  it("enforces pinned images, workspace labels, and unprivileged networking", async () => {
    const runtime = new FakeRuntime();
    const client = await createDockerSandboxDriver({ runtime }).create(
      { allowedImages: [request.image!] },
      { signal: new AbortController().signal, scopeId: "scope", workspaceId: "workspace-1" },
    );
    const sandbox = await client.create(request, operation());
    expect(runtime.spec).toMatchObject({
      image: request.image,
      networkDisabled: true,
      privileged: false,
      mounts: [],
      labels: { "openmuse.workspace_id": "workspace-1" },
    });
    await expect(
      sandbox.execute({ argv: ["echo", "ok"], cwd: "/workspace" }, operation()),
    ).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(client.create({ image: "node:latest" }, operation())).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("rejects cross-workspace reconnects and cleans resources", async () => {
    const runtime = new FakeRuntime();
    const client = await createDockerSandboxDriver({ runtime }).create(
      { allowedImages: [request.image!] },
      { signal: new AbortController().signal, scopeId: "scope", workspaceId: "workspace-1" },
    );
    await expect(client.reconnect("container-1", operation("workspace-2"))).rejects.toMatchObject({
      code: "permission_denied",
    });
    const sandbox = await client.reconnect("container-1", operation());
    await sandbox.close("test cleanup");
    expect(runtime.container.destroyed).toBe(true);
  });
});
