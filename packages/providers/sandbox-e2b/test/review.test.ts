import { describe, expect, it } from "vitest";
import { E2B } from "e2b";
import type {
  ProviderCreateContext,
  ProviderOperationContext,
  SandboxConfig,
  SandboxCreateRequest,
} from "@openmuse/provider-contracts";
import {
  createE2BSandboxDriver,
  createOfficialE2BFactory,
  type E2BClientFactory,
  type E2BCommandHandle,
  type E2BCommandResult,
  type E2BCommandStartOptions,
  type E2BConnectOptions,
  type E2BCommands,
  type E2BFiles,
  type E2BSandbox,
  type E2BSandboxClass,
  type E2BSandboxInfo,
} from "../src/index.js";

const template = "review-e2b-template";
const instanceId = "review-e2b-instance";

function operation(overrides: Partial<ProviderOperationContext> = {}): ProviderOperationContext {
  return {
    signal: new AbortController().signal,
    operationId: crypto.randomUUID(),
    workspaceId: "workspace-1",
    tenantId: "tenant-1",
    userId: "user-1",
    ...overrides,
  };
}

function createContext(signal = new AbortController().signal): ProviderCreateContext {
  return {
    signal,
    scopeId: "review-scope",
    workspaceId: "workspace-1",
    tenantId: "tenant-1",
    userId: "user-1",
    secrets: { resolve: async () => "review-secret" },
  };
}

class ReviewHandle implements E2BCommandHandle {
  readonly pid = 42;
  stdout = "ok";
  stderr = "";
  readonly result: E2BCommandResult = { exitCode: 0, stdout: "ok", stderr: "" };

  async wait(): Promise<E2BCommandResult> {
    return this.result;
  }

  async kill(): Promise<boolean> {
    return true;
  }
}

class ReviewFiles implements E2BFiles {
  readValue = new Uint8Array([1, 2, 3]);
  readCalls = 0;
  writeCalls = 0;
  readonly values = new Map<string, Uint8Array>();

  async read(): Promise<Uint8Array> {
    this.readCalls += 1;
    return this.readValue;
  }

  async write(path: string, data: ArrayBuffer): Promise<void> {
    this.writeCalls += 1;
    this.values.set(path, new Uint8Array(data.slice(0)));
  }
}

class ReviewCommands implements E2BCommands {
  readonly handle = new ReviewHandle();

  async run(_command: string, _options: E2BCommandStartOptions): Promise<E2BCommandHandle> {
    return this.handle;
  }
}

class ReviewSandbox implements E2BSandbox {
  readonly sandboxId = "review-e2b-sandbox";
  readonly files = new ReviewFiles();
  readonly commands = new ReviewCommands();
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
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    endAt: new Date("2099-01-01T00:00:00.000Z"),
    state: "running",
    cpuCount: 1,
    memoryMB: 512,
  };
  killFailures = 0;
  killCalls = 0;

  async getInfo(): Promise<E2BSandboxInfo> {
    return this.info;
  }

  async kill(): Promise<boolean> {
    this.killCalls += 1;
    if (this.killFailures > 0) {
      this.killFailures -= 1;
      throw new Error("kill unavailable");
    }
    return true;
  }

  async setTimeout(): Promise<void> {}
}

class ReviewSandboxClass implements E2BSandboxClass {
  readonly sandbox = new ReviewSandbox();
  connectOptions?: E2BConnectOptions;

  async create(): Promise<E2BSandbox> {
    return this.sandbox;
  }

  async connect(_id: string, options?: E2BConnectOptions): Promise<E2BSandbox> {
    this.connectOptions = options;
    return this.sandbox;
  }

  async getInfo(): Promise<E2BSandboxInfo> {
    return this.sandbox.info;
  }

  async kill(): Promise<boolean> {
    return this.sandbox.kill();
  }
}

class ReviewFactory implements E2BClientFactory {
  readonly sandboxClass = new ReviewSandboxClass();

  async create(): Promise<E2BSandboxClass> {
    return this.sandboxClass;
  }
}

function config(overrides: Record<string, unknown> = {}): SandboxConfig {
  return {
    apiKeySecret: "e2b-key",
    template,
    allowedTemplates: [template],
    ...overrides,
  } as SandboxConfig;
}

async function createClient(factory: ReviewFactory, overrides: Record<string, unknown> = {}) {
  return createE2BSandboxDriver({ factory, instanceId }).create(config(overrides), createContext());
}

const request: SandboxCreateRequest = { image: template };

describe("E2B independent regressions", () => {
  it("constructs the pinned E2B SDK through the official factory without network I/O", async () => {
    const factory = createOfficialE2BFactory(E2B);
    const sdk = await factory.create({ apiKey: "review-key", apiUrl: "https://example.invalid" });

    expect(typeof sdk.create).toBe("function");
    expect(typeof sdk.connect).toBe("function");
    expect(typeof sdk.getInfo).toBe("function");
  });

  it("retains failed cleanup so a caller can retry close", async () => {
    const factory = new ReviewFactory();
    factory.sandboxClass.sandbox.killFailures = 1;
    const client = await createClient(factory);
    await client.create(request, operation());

    await expect(client.close()).rejects.toMatchObject({ code: "unknown_outcome" });
    await expect(client.close()).resolves.toBeUndefined();
    expect(factory.sandboxClass.sandbox.killCalls).toBe(2);
  });

  it("advertises no file capability and rejects file operations before SDK mutation", async () => {
    const factory = new ReviewFactory();
    const driver = createE2BSandboxDriver({ factory, instanceId });
    expect(driver.metadata.capabilities.map(({ key }) => key)).not.toContain("sandbox.files");
    const client = await driver.create(config(), createContext());
    const sandbox = await client.create(request, operation());

    await expect(sandbox.readFile("/workspace/output.bin", operation())).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(
      sandbox.writeFile({ path: "/workspace/output.bin", bytes: new Uint8Array([1]) }, operation()),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(factory.sandboxClass.sandbox.files.readCalls).toBe(0);
    expect(factory.sandboxClass.sandbox.files.writeCalls).toBe(0);
    expect(factory.sandboxClass.sandbox.files.values.size).toBe(0);
  });

  it("rejects operations that omit the bound scope", async () => {
    const factory = new ReviewFactory();
    const client = await createClient(factory);
    const sandbox = await client.create(request, operation());

    await expect(
      sandbox.execute(
        { argv: ["printf", "scope"] },
        operation({ workspaceId: undefined, tenantId: undefined, userId: undefined }),
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("does not reconnect a sandbox whose vendor lifetime exceeds maxSeconds", async () => {
    const factory = new ReviewFactory();
    const client = await createClient(factory, { maxSeconds: 1 });

    const outcome = await client
      .reconnect(factory.sandboxClass.sandbox.sandboxId, operation())
      .then(
        () => ({ resolved: true as const }),
        (error) => ({ resolved: false as const, error }),
      );
    expect(outcome.resolved).toBe(false);
    if (!outcome.resolved) expect(outcome.error).toMatchObject({ code: "invalid_request" });
  });

  it("caps reconnect execution by E2B's remaining absolute lifetime", async () => {
    const factory = new ReviewFactory();
    factory.sandboxClass.sandbox.info.endAt = new Date(Date.now() + 25_000);
    const client = await createClient(factory, { maxSeconds: 180 });

    const sandbox = await client.reconnect(factory.sandboxClass.sandbox.sandboxId, operation());

    expect(sandbox.metadata.limits.timeoutSeconds).toBeGreaterThan(0);
    expect(sandbox.metadata.limits.timeoutSeconds).toBeLessThan(60);
    expect(factory.sandboxClass.connectOptions?.timeoutMs).toBeLessThan(60_000);
  });

  it("rejects an expired E2B sandbox during reconnect", async () => {
    const factory = new ReviewFactory();
    factory.sandboxClass.sandbox.info.endAt = new Date(Date.now() - 1_000);
    const client = await createClient(factory);

    await expect(
      client.reconnect(factory.sandboxClass.sandbox.sandboxId, operation()),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects oversized buffered command output", async () => {
    const factory = new ReviewFactory();
    factory.sandboxClass.sandbox.commands.handle.stdout = "123";
    factory.sandboxClass.sandbox.commands.handle.result.stdout = "123";
    const client = await createClient(factory, { maxOutputBytes: 2 });
    const sandbox = await client.create(request, operation());

    await expect(sandbox.execute({ argv: ["printf", "123"] }, operation())).rejects.toMatchObject({
      code: "failed",
    });
  });
});
