import { describe, expect, it } from "vitest";
import type {
  ProviderOperationContext,
  SandboxConfig,
  SandboxCreateRequest,
} from "@openmuse/provider-contracts";
import {
  createDaytonaSandboxDriver,
  type DaytonaCreateParams,
  type DaytonaExecuteResponse,
  type DaytonaFileSystem,
  type DaytonaProcess,
  type DaytonaSandbox,
  type DaytonaSdkClient,
  type DaytonaSdkFactory,
} from "../src/index.js";

const image = "daytona-snapshot";

function operation(workspaceId = "workspace-1"): ProviderOperationContext {
  return {
    signal: new AbortController().signal,
    operationId: crypto.randomUUID(),
    workspaceId,
  };
}

class FakeProcess implements DaytonaProcess {
  lastCommand?: { command: string; cwd?: string; env?: Record<string, string>; timeout?: number };
  response: DaytonaExecuteResponse = { exitCode: 0, result: "ok" };
  pending = false;

  async executeCommand(
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number,
  ): Promise<DaytonaExecuteResponse> {
    this.lastCommand = { command, cwd, env, timeout };
    if (this.pending) return new Promise(() => {});
    return this.response;
  }
}

class FakeFileSystem implements DaytonaFileSystem {
  readonly files = new Map<string, Uint8Array>();

  async downloadFile(path: string): Promise<Uint8Array> {
    return this.files.get(path) ?? new Uint8Array();
  }

  async uploadFile(file: Uint8Array, path: string): Promise<void> {
    this.files.set(path, new Uint8Array(file));
  }
}

class FakeSandbox implements DaytonaSandbox {
  readonly id = "daytona-1";
  readonly labels: Record<string, string> = {
    "openmuse.workspace_id": "workspace-1",
    "openmuse.provider": "sandbox-daytona",
    "openmuse.instance_id": "test-daytona",
    "openmuse.tenant_id": "",
    "openmuse.user_id": "",
  };
  readonly state = "started";
  readonly snapshot = image;
  readonly cpu = 1;
  readonly memory = 0.5;
  readonly disk = 0.5;
  readonly process = new FakeProcess();
  readonly fs = new FakeFileSystem();
  readonly createdAt = "2026-01-01T00:00:00.000Z";
  readonly autoDestroyAt = "2026-01-01T00:15:00.000Z";
  refreshCount = 0;
  destroyed = false;
  lastDelete?: { timeout?: number; wait?: boolean };

  async refreshData(): Promise<void> {
    this.refreshCount += 1;
  }

  async delete(timeout?: number, wait?: boolean): Promise<void> {
    this.lastDelete = { timeout, wait };
    this.destroyed = true;
  }
}

class FakeFactory implements DaytonaSdkFactory {
  readonly sandbox = new FakeSandbox();
  createParams?: DaytonaCreateParams;

  async create(): Promise<DaytonaSdkClient> {
    return {
      create: async (params) => {
        this.createParams = params;
        return this.sandbox;
      },
      get: async () => this.sandbox,
    };
  }
}

const request: SandboxCreateRequest = { image };
const config = {
  apiKeySecret: "daytona-key",
  snapshot: image,
  allowedSnapshots: [image],
} as SandboxConfig;

async function createClient(factory: FakeFactory) {
  return createDaytonaSandboxDriver({ factory, instanceId: "test-daytona" }).create(config, {
    signal: new AbortController().signal,
    scopeId: "scope",
    workspaceId: "workspace-1",
    secrets: { resolve: async () => "secret-value" },
  });
}

describe("Daytona sandbox provider", () => {
  it("maps the official SDK methods and binds every operation to a workspace", async () => {
    const factory = new FakeFactory();
    const client = await createClient(factory);
    const sandbox = await client.create(request, operation());

    expect(factory.createParams).toMatchObject({
      snapshot: image,
      labels: {
        "openmuse.workspace_id": "workspace-1",
        "openmuse.provider": "sandbox-daytona",
      },
      resources: { cpu: 1, memory: 0.5, disk: 0.5 },
    });
    await expect(
      sandbox.execute({ argv: ["printf", "hello world", "a'b"], cwd: "/workspace" }, operation()),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(factory.sandbox.process.lastCommand).toMatchObject({
      command: "'printf' 'hello world' 'a'\\''b'",
      cwd: "/workspace",
    });
    await sandbox.writeFile(
      { path: "/workspace/value.txt", bytes: new Uint8Array([1, 2]) },
      operation(),
    );
    await expect(sandbox.readFile("/workspace/value.txt", operation())).resolves.toEqual(
      new Uint8Array([1, 2]),
    );
    await expect(client.reconnect("daytona-1", operation("workspace-2"))).rejects.toMatchObject({
      code: "permission_denied",
    });
    await sandbox.close();
    expect(factory.sandbox.destroyed).toBe(true);
    expect(factory.sandbox.lastDelete).toMatchObject({ wait: true });
  });

  it("rejects unsupported process limits, oversized files, and unsafe paths", async () => {
    const factory = new FakeFactory();
    const client = await createClient(factory);
    await expect(client.create({ image, limits: { pids: 64 } }, operation())).rejects.toMatchObject(
      { code: "invalid_request" },
    );
    const sandbox = await client.create(request, operation());
    await expect(
      sandbox.writeFile({ path: "/workspace/../secret", bytes: new Uint8Array([1]) }, operation()),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("deletes the sandbox before reporting a deterministic timeout", async () => {
    const factory = new FakeFactory();
    factory.sandbox.process.pending = true;
    const client = await createClient(factory);
    const sandbox = await client.create({ image, limits: { timeoutSeconds: 1 } }, operation());
    await expect(
      sandbox.execute({ argv: ["sleep", "2"], timeoutSeconds: 1 }, operation()),
    ).resolves.toMatchObject({ exitCode: 124, timedOut: true });
    expect(factory.sandbox.destroyed).toBe(true);
  });
});
