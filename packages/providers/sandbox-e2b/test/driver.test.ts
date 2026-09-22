import { describe, expect, it } from "vitest";
import type {
  ProviderCreateContext,
  ProviderOperationContext,
  SandboxConfig,
} from "@openmuse/provider-contracts";
import {
  createE2BSandboxDriver,
  type E2BClientFactory,
  type E2BCommandHandle,
  type E2BCommandResult,
  type E2BCommandStartOptions,
  type E2BCommands,
  type E2BFileInfo,
  type E2BFiles,
  type E2BSandbox,
  type E2BSandboxClass,
  type E2BSandboxInfo,
} from "../src/index.js";

const template = "openmuse-template";
const instanceId = "e2b-test-instance";

function operation(
  workspaceId = "workspace-1",
  userId = "user-1",
  signal = new AbortController().signal,
): ProviderOperationContext {
  return {
    signal,
    operationId: crypto.randomUUID(),
    workspaceId,
    tenantId: "tenant-1",
    userId,
  };
}

class FakeHandle implements E2BCommandHandle {
  readonly pid = 42;
  stdout = "hello";
  stderr = "";
  result: E2BCommandResult = { exitCode: 0, stdout: "hello", stderr: "" };
  pending = false;
  killCount = 0;

  async wait(): Promise<E2BCommandResult> {
    if (this.pending) return new Promise(() => {});
    return this.result;
  }

  async kill(): Promise<boolean> {
    this.killCount += 1;
    this.pending = false;
    return true;
  }
}

class FakeFiles implements E2BFiles {
  readonly values = new Map<string, Uint8Array>();
  pendingWrite = false;
  lastWrite?: { path: string; bytes: Uint8Array };

  async read(path: string): Promise<Uint8Array> {
    return this.values.get(path) ?? new Uint8Array();
  }

  async write(path: string, data: ArrayBuffer): Promise<void> {
    this.lastWrite = { path, bytes: new Uint8Array(data.slice(0)) };
    if (this.pendingWrite) return new Promise(() => {});
    this.values.set(path, new Uint8Array(data.slice(0)));
  }

  async getInfo(): Promise<E2BFileInfo> {
    return { type: "file" };
  }
}

class FakeCommands implements E2BCommands {
  readonly handle = new FakeHandle();
  last?: { command: string; options: E2BCommandStartOptions };

  async run(command: string, options: E2BCommandStartOptions): Promise<E2BCommandHandle> {
    this.last = { command, options };
    return this.handle;
  }
}

class FakeSandbox implements E2BSandbox {
  readonly sandboxId = "e2b-sandbox-1";
  readonly files = new FakeFiles();
  readonly commands = new FakeCommands();
  readonly info: E2BSandboxInfo = {
    sandboxId: this.sandboxId,
    templateId: template,
    metadata: {
      "openmuse.provider": "sandbox-e2b",
      "openmuse.instance_id": instanceId,
      "openmuse.workspace_id": "workspace-1",
      "openmuse.tenant_id": "tenant-1",
      "openmuse.user_id": "user-1",
    },
    state: "running",
    cpuCount: 1,
    memoryMB: 512,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    endAt: new Date("2026-01-01T00:01:00.000Z"),
  };
  killCount = 0;
  lastCreateTimeout?: number;

  async getInfo(): Promise<E2BSandboxInfo> {
    return this.info;
  }

  async kill(): Promise<boolean> {
    this.killCount += 1;
    return true;
  }

  async setTimeout(timeoutMs: number): Promise<void> {
    this.lastCreateTimeout = timeoutMs;
  }
}

class FakeSandboxClass implements E2BSandboxClass {
  readonly sandbox = new FakeSandbox();
  readonly created: Array<{ template: string; options?: unknown }> = [];

  async create(templateName: string, options?: unknown): Promise<E2BSandbox> {
    this.created.push({ template: templateName, options });
    return this.sandbox;
  }

  async connect(): Promise<E2BSandbox> {
    return this.sandbox;
  }

  async getInfo(): Promise<E2BSandboxInfo> {
    return this.sandbox.info;
  }

  async kill(): Promise<boolean> {
    return this.sandbox.kill();
  }
}

class FakeFactory implements E2BClientFactory {
  readonly sandboxClass = new FakeSandboxClass();

  async create(): Promise<E2BSandboxClass> {
    return this.sandboxClass;
  }
}

const config = {
  apiKeySecret: "e2b-key",
  template,
  allowedTemplates: [template],
} as SandboxConfig;

function createContext(signal = new AbortController().signal): ProviderCreateContext {
  return {
    signal,
    scopeId: "scope",
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    secrets: { resolve: async () => "secret-value" },
  };
}

async function createClient(factory: FakeFactory) {
  return createE2BSandboxDriver({ factory, instanceId }).create(config, createContext());
}

describe("E2B sandbox provider", () => {
  it("maps official SDK methods and binds every operation to the scope", async () => {
    const factory = new FakeFactory();
    const client = await createClient(factory);
    const sandbox = await client.create({ image: template }, operation());
    expect(factory.sandboxClass.created[0]).toMatchObject({ template });
    expect(factory.sandboxClass.created[0]?.options).toMatchObject({
      metadata: {
        "openmuse.provider": "sandbox-e2b",
        "openmuse.instance_id": instanceId,
        "openmuse.workspace_id": "workspace-1",
        "openmuse.tenant_id": "tenant-1",
        "openmuse.user_id": "user-1",
      },
    });
    await expect(
      sandbox.execute({ argv: ["printf", "hello world", "a'b"], cwd: "/workspace" }, operation()),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "hello" });
    expect(factory.sandboxClass.sandbox.commands.last).toMatchObject({
      command: "'printf' 'hello world' 'a'\\''b'",
    });
    await sandbox.writeFile(
      { path: "/workspace/value.txt", bytes: new Uint8Array([1, 2]) },
      operation(),
    );
    await expect(sandbox.readFile("/workspace/value.txt", operation())).resolves.toEqual(
      new Uint8Array([1, 2]),
    );
    await expect(
      client.reconnect("e2b-sandbox-1", operation("workspace-1", "other-user")),
    ).rejects.toMatchObject({
      code: "permission_denied",
    });
    await sandbox.close();
    expect(factory.sandboxClass.sandbox.killCount).toBe(1);
  });

  it("fails closed for templates, unsupported limits, and unsafe paths", async () => {
    const factory = new FakeFactory();
    const client = await createClient(factory);
    await expect(client.create({ image: "untrusted" }, operation())).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(
      client.create({ image: template, limits: { cpu: 2 } }, operation()),
    ).rejects.toMatchObject({ code: "invalid_request" });
    const sandbox = await client.create({ image: template }, operation());
    await expect(
      sandbox.writeFile({ path: "/workspace/../secret", bytes: new Uint8Array([1]) }, operation()),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("kills a running command before returning caller cancellation", async () => {
    const factory = new FakeFactory();
    factory.sandboxClass.sandbox.commands.handle.pending = true;
    const client = await createClient(factory);
    const sandbox = await client.create({ image: template }, operation());
    const controller = new AbortController();
    const pending = sandbox.execute(
      { argv: ["sleep", "60"] },
      operation("workspace-1", "user-1", controller.signal),
    );
    setTimeout(() => controller.abort(), 0);
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(factory.sandboxClass.sandbox.commands.handle.killCount).toBe(1);
    expect(factory.sandboxClass.sandbox.killCount).toBe(0);
  });

  it("reports unknown outcome when command cancellation cannot be verified", async () => {
    const factory = new FakeFactory();
    factory.sandboxClass.sandbox.commands.handle.pending = true;
    factory.sandboxClass.sandbox.commands.handle.kill = async () => {
      throw new Error("kill unavailable");
    };
    const client = await createClient(factory);
    const sandbox = await client.create({ image: template }, operation());
    const controller = new AbortController();
    const pending = sandbox.execute(
      { argv: ["sleep", "60"] },
      operation("workspace-1", "user-1", controller.signal),
    );
    setTimeout(() => controller.abort(), 0);
    await expect(pending).rejects.toMatchObject({ code: "unknown_outcome", uncertain: true });
  });
});
