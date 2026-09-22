import { describe, expect, it } from "vitest";
import { Daytona } from "@daytonaio/sdk";
import type {
  ProviderCreateContext,
  ProviderOperationContext,
  SandboxConfig,
  SandboxCreateRequest,
} from "@openmuse/provider-contracts";
import {
  createDaytonaSandboxDriver,
  createOfficialDaytonaFactory,
  type DaytonaCreateParams,
  type DaytonaExecuteResponse,
  type DaytonaFileSystem,
  type DaytonaProcess,
  type DaytonaSandbox,
  type DaytonaSdkClient,
  type DaytonaSdkFactory,
} from "../src/index.js";

const image = "review-daytona-snapshot";
const instanceId = "review-daytona-instance";

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

class ReviewProcess implements DaytonaProcess {
  response: DaytonaExecuteResponse = { exitCode: 0, result: "ok" };

  async executeCommand(): Promise<DaytonaExecuteResponse> {
    return this.response;
  }
}

class ReviewFileSystem implements DaytonaFileSystem {
  readonly values = new Map<string, Uint8Array>();
  downloadValue = new Uint8Array([1, 2, 3]);
  downloadCalls = 0;
  uploadCalls = 0;

  async downloadFile(): Promise<Uint8Array> {
    this.downloadCalls += 1;
    return this.downloadValue;
  }

  async uploadFile(file: Uint8Array, path: string): Promise<void> {
    this.uploadCalls += 1;
    this.values.set(path, new Uint8Array(file));
  }
}

class ReviewSandbox implements DaytonaSandbox {
  readonly id = "review-daytona-sandbox";
  readonly labels: Readonly<Record<string, string>> = {
    "openmuse.provider": "sandbox-daytona",
    "openmuse.instance_id": instanceId,
    "openmuse.workspace_id": "workspace-1",
    "openmuse.tenant_id": "tenant-1",
    "openmuse.user_id": "user-1",
  };
  readonly state = "started";
  readonly snapshot = image;
  readonly createdAt = "2026-01-01T00:00:00.000Z";
  readonly autoDestroyAt = "2099-01-01T00:00:00.000Z";
  readonly cpu = 1;
  readonly memory = 0.5;
  readonly disk = 0.5;
  readonly process = new ReviewProcess();
  readonly fs = new ReviewFileSystem();
  deleteFailures = 0;
  deleteCalls = 0;
  deleted = false;

  async refreshData(): Promise<void> {}

  async delete(): Promise<void> {
    this.deleteCalls += 1;
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new Error("delete unavailable");
    }
    this.deleted = true;
  }
}

class ReviewFactory implements DaytonaSdkFactory {
  readonly sandbox = new ReviewSandbox();
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

function config(overrides: Record<string, unknown> = {}): SandboxConfig {
  return {
    apiKeySecret: "daytona-key",
    snapshot: image,
    allowedSnapshots: [image],
    ...overrides,
  } as SandboxConfig;
}

async function createClient(factory: ReviewFactory, overrides: Record<string, unknown> = {}) {
  return createDaytonaSandboxDriver({ factory, instanceId }).create(
    config(overrides),
    createContext(),
  );
}

describe("Daytona independent regressions", () => {
  it("constructs the pinned Daytona SDK through the official factory without network I/O", async () => {
    const factory = createOfficialDaytonaFactory(Daytona);
    const sdk = await factory.create({
      apiKey: "review-key",
      apiUrl: "https://example.invalid/api",
      target: "review-target",
    });

    expect(typeof sdk.create).toBe("function");
    expect(typeof sdk.get).toBe("function");
  });

  it("retains failed cleanup so a caller can retry close", async () => {
    const factory = new ReviewFactory();
    factory.sandbox.deleteFailures = 1;
    const client = await createClient(factory);
    await client.create(request, operation());

    await expect(client.close()).rejects.toMatchObject({ code: "unknown_outcome" });
    await expect(client.close()).resolves.toBeUndefined();
    expect(factory.sandbox.deleteCalls).toBe(2);
    expect(factory.sandbox.deleted).toBe(true);
  });

  it("advertises no file capability and rejects file operations before SDK mutation", async () => {
    const factory = new ReviewFactory();
    const driver = createDaytonaSandboxDriver({ factory, instanceId });
    expect(driver.metadata.capabilities.map(({ key }) => key)).not.toContain("sandbox.files");
    const client = await driver.create(config(), createContext());
    const sandbox = await client.create(request, operation());

    await expect(sandbox.readFile("/workspace/output.bin", operation())).rejects.toMatchObject({
      code: "permission_denied",
    });
    await expect(
      sandbox.writeFile({ path: "/workspace/output.bin", bytes: new Uint8Array([1]) }, operation()),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(factory.sandbox.fs.downloadCalls).toBe(0);
    expect(factory.sandbox.fs.uploadCalls).toBe(0);
    expect(factory.sandbox.fs.values.size).toBe(0);
  });

  it("uses Daytona's absolute TTL without inactivity cleanup fields", async () => {
    const factory = new ReviewFactory();
    const client = await createClient(factory, { maxSeconds: 180 });
    const sandbox = await client.create({ image, limits: { timeoutSeconds: 119 } }, operation());

    expect(factory.createParams).toMatchObject({ ttlMinutes: 1 });
    expect(factory.createParams).not.toHaveProperty("autoStopInterval");
    expect(factory.createParams).not.toHaveProperty("autoDeleteInterval");
    expect(sandbox.metadata.limits.timeoutSeconds).toBe(60);
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
    const client = await createClient(factory, { maxSeconds: 60 });

    const outcome = await client.reconnect(factory.sandbox.id, operation()).then(
      () => ({ resolved: true as const }),
      (error) => ({ resolved: false as const, error }),
    );
    expect(outcome.resolved).toBe(false);
    if (!outcome.resolved) expect(outcome.error).toMatchObject({ code: "invalid_request" });
  });

  it("rejects oversized buffered command output", async () => {
    const factory = new ReviewFactory();
    factory.sandbox.process.response = { exitCode: 0, result: "123" };
    const client = await createClient(factory, { maxOutputBytes: 2 });
    const sandbox = await client.create(request, operation());

    await expect(sandbox.execute({ argv: ["printf", "123"] }, operation())).rejects.toMatchObject({
      code: "failed",
    });
  });
});
