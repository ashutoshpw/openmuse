import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HARD_MAX_OBJECT_BYTES,
  createS3StorageDriver,
  normalizeTrustedEndpoint,
  storageConfigSchema,
  storageInternalKeyPattern,
  validateStorageContentType,
  validateStorageLogicalKey,
} from "../src/index.js";
import type { StorageS3DriverOptions } from "../src/index.js";

const signal = new AbortController().signal;
const context = {
  signal,
  scopeId: "storage-test",
  tenantId: "tenant-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  providerInstanceId: "storage-instance-1",
} as const;

const runtimeCredentials = {
  accessKeyId: "openmuse-test-access",
  secretAccessKey: "openmuse-test-secret",
} as const;

function runtimeDriver(
  bucket = "openmuse-test",
  endpoint?: string,
  options: Omit<StorageS3DriverOptions, "credentials" | "trustedTargets"> = {},
) {
  return createS3StorageDriver({
    ...options,
    credentials: runtimeCredentials,
    trustedTargets: [{ bucket, ...(endpoint === undefined ? {} : { endpoint }) }],
  });
}

function operation(operationId: string, overrides: Record<string, unknown> = {}) {
  return {
    signal,
    operationId,
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    providerInstanceId: "storage-instance-1",
    ...overrides,
  };
}

function scopedObjectKey(): string {
  const scope = createHash("sha256")
    .update(
      JSON.stringify({
        tenantId: "tenant-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        providerInstanceId: "storage-instance-1",
      }),
    )
    .digest("base64url");
  return `openmuse/v1/${scope}/${"b".repeat(43)}`;
}

function fakeS3(send: (command: unknown) => Promise<unknown>): S3Client {
  return Object.assign(new S3Client({ region: "us-east-1", credentials: runtimeCredentials }), {
    send,
    destroy() {},
  }) as S3Client;
}

describe("S3 storage policy", () => {
  it("normalizes bounded configuration defaults", () => {
    expect(storageConfigSchema.parse({ bucket: "openmuse-test" })).toMatchObject({
      bucket: "openmuse-test",
      region: "us-east-1",
      maxObjectBytes: 10 * 1024 * 1024,
      maxSignedUrlSeconds: 300,
    });
    expect(() =>
      storageConfigSchema.parse({
        bucket: "openmuse-test",
        maxObjectBytes: HARD_MAX_OBJECT_BYTES + 1,
      }),
    ).toThrow();
    expect(
      storageConfigSchema.parse({
        bucket: "openmuse-test",
        accessKeyIdSecret: "access-key-ref",
        secretAccessKeySecret: "secret-key-ref",
        sessionTokenSecret: "session-ref",
      }),
    ).toMatchObject({
      accessKeyIdSecret: "access-key-ref",
      secretAccessKeySecret: "secret-key-ref",
      sessionTokenSecret: "session-ref",
    });
    expect(() =>
      storageConfigSchema.parse({ bucket: "openmuse-test", accessKeyIdSecret: "access-key-ref" }),
    ).toThrow();
  });

  it("rejects path, URL, and traversal-like caller keys", () => {
    for (const key of [
      "../escape",
      "/absolute",
      "nested/file",
      "https://attacker.test/x",
      "//host",
    ]) {
      expect(() => validateStorageLogicalKey(key)).toThrow("key");
    }
    expect(() => validateStorageLogicalKey("safe-name.png")).not.toThrow();
    expect(storageInternalKeyPattern.test(`openmuse/v1/${"a".repeat(43)}/${"b".repeat(43)}`)).toBe(
      true,
    );
  });

  it("requires a valid MIME type and deployment-approved endpoint", async () => {
    expect(validateStorageContentType("image/png")).toBe("image/png");
    expect(validateStorageContentType("text/plain; charset=utf-8")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(() => validateStorageContentType("not-a-mime")).toThrow("content type");
    expect(normalizeTrustedEndpoint("http://127.0.0.1:9000/")).toBe("http://127.0.0.1:9000");

    const driver = createS3StorageDriver();
    await expect(
      driver.create({ bucket: "openmuse-test", endpoint: "http://127.0.0.1:9000" }, context),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      driver.create(
        { bucket: "openmuse-test", endpoint: "http://user:password@127.0.0.1:9000" },
        context,
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("does not construct an S3 client without BYOK or explicit trusted runtime credentials", async () => {
    let constructed = false;
    const driver = createS3StorageDriver({
      clientFactory: () => {
        constructed = true;
        return fakeS3(async () => ({}));
      },
    });

    await expect(driver.create({ bucket: "openmuse-test" }, context)).rejects.toMatchObject({
      code: "authentication_required",
    });
    expect(constructed).toBe(false);
  });

  it("passes explicit runtime credentials only for an approved endpoint and bucket", async () => {
    let receivedConfig: Record<string, unknown> | undefined;
    const client = await runtimeDriver("openmuse-test", undefined, {
      clientFactory: (config) => {
        receivedConfig = config as Record<string, unknown>;
        return fakeS3(async () => ({}));
      },
    }).create({ bucket: "openmuse-test" }, context);

    expect(receivedConfig?.credentials).toEqual(runtimeCredentials);
    await client.close();

    let constructed = false;
    const unapproved = createS3StorageDriver({
      credentials: runtimeCredentials,
      trustedTargets: [{ bucket: "approved-bucket" }],
      clientFactory: () => {
        constructed = true;
        return fakeS3(async () => ({}));
      },
    });
    await expect(unapproved.create({ bucket: "other-bucket" }, context)).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(constructed).toBe(false);
  });

  it("resolves caller BYOK credentials and never falls back to runtime credentials", async () => {
    const resolved = new Map([
      ["access-key-ref", "caller-access"],
      ["secret-key-ref", "caller-secret"],
      ["session-ref", "caller-session"],
    ]);
    let receivedConfig: Record<string, unknown> | undefined;
    const driver = createS3StorageDriver({
      credentials: runtimeCredentials,
      trustedTargets: [{ bucket: "openmuse-test" }],
      clientFactory: (config) => {
        receivedConfig = config as Record<string, unknown>;
        return fakeS3(async () => ({}));
      },
    });
    const client = await driver.create(
      {
        bucket: "openmuse-test",
        accessKeyIdSecret: "access-key-ref",
        secretAccessKeySecret: "secret-key-ref",
        sessionTokenSecret: "session-ref",
      },
      {
        ...context,
        secrets: {
          resolve: async (reference, signal) => {
            expect(signal).toBe(context.signal);
            const value = resolved.get(reference);
            if (!value) throw new Error("unexpected secret reference");
            return value;
          },
        },
      },
    );
    expect(receivedConfig?.credentials).toEqual({
      accessKeyId: "caller-access",
      secretAccessKey: "caller-secret",
      sessionToken: "caller-session",
    });
    await client.close();

    let constructed = false;
    const noResolver = createS3StorageDriver({
      credentials: runtimeCredentials,
      trustedTargets: [{ bucket: "openmuse-test" }],
      clientFactory: () => {
        constructed = true;
        return fakeS3(async () => ({}));
      },
    });
    await expect(
      noResolver.create(
        {
          bucket: "openmuse-test",
          accessKeyIdSecret: "access-key-ref",
          secretAccessKeySecret: "secret-key-ref",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "authentication_required" });
    expect(constructed).toBe(false);
  });

  it("does not expose caller secrets in provider errors or redacted config", async () => {
    const secretValue = "caller-secret-value";
    const driver = createS3StorageDriver({
      clientFactory: () => fakeS3(async () => ({})),
    });
    const redacted = driver.config.redact?.({
      bucket: "openmuse-test",
      accessKeyIdSecret: "access-key-ref",
      secretAccessKeySecret: "secret-key-ref",
      sessionTokenSecret: "session-ref",
    });
    expect(JSON.stringify(redacted)).not.toContain("access-key-ref");
    expect(JSON.stringify(redacted)).not.toContain("secret-key-ref");
    expect(JSON.stringify(redacted)).not.toContain("session-ref");

    let thrown: unknown;
    try {
      await driver.create(
        {
          bucket: "openmuse-test",
          accessKeyIdSecret: "access-key-ref",
          secretAccessKeySecret: "secret-key-ref",
        },
        {
          ...context,
          secrets: {
            resolve: async () => {
              throw new Error(secretValue);
            },
          },
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "authentication_required" });
    expect(String(thrown)).not.toContain(secretValue);
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
    expect((thrown as { details?: unknown }).details).toBeUndefined();
  });

  it("requires workspace and actor scope before constructing a client", async () => {
    let constructed = false;
    const driver = createS3StorageDriver({
      clientFactory: () => {
        constructed = true;
        return new S3Client({ region: "us-east-1" });
      },
    });
    await expect(
      driver.create(
        { bucket: "openmuse-test" },
        { signal, scopeId: "storage-test", workspaceId: "workspace-1" },
      ),
    ).rejects.toMatchObject({ code: "scope_missing" });
    expect(constructed).toBe(false);
  });

  it("does not construct a client after the create signal is aborted", async () => {
    const aborted = new AbortController();
    aborted.abort();
    let constructed = false;
    const driver = createS3StorageDriver({
      clientFactory: () => {
        constructed = true;
        return new S3Client({ region: "us-east-1" });
      },
    });
    await expect(
      driver.create({ bucket: "openmuse-test" }, { ...context, signal: aborted.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(constructed).toBe(false);
  });

  it("requires the registry-provided provider instance binding", async () => {
    const driver = createS3StorageDriver({
      clientFactory: () => new S3Client({ region: "us-east-1" }),
    });
    await expect(
      driver.create(
        { bucket: "openmuse-test" },
        { signal, scopeId: "storage-test", workspaceId: "workspace-1", userId: "user-1" },
      ),
    ).rejects.toMatchObject({ code: "scope_missing" });
  });

  it("uses workspace, actor, and instance as the canonical scope without a tenant", async () => {
    const driver = runtimeDriver();
    const client = await driver.create(
      { bucket: "openmuse-test" },
      { ...context, tenantId: undefined },
    );
    await client.close();
  });

  it("does not allow an operation to omit a bound tenant or switch actor", async () => {
    const driver = runtimeDriver();
    const client = await driver.create({ bucket: "openmuse-test" }, context);
    const foreignKey = `openmuse/v1/${"a".repeat(43)}/${"b".repeat(43)}`;
    await expect(
      client.head("https://attacker.test/object", {
        signal,
        operationId: "operation-1",
        providerInstanceId: "storage-instance-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        tenantId: "tenant-1",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      client.head(foreignKey, {
        signal,
        operationId: "operation-2",
        providerInstanceId: "other-instance",
        workspaceId: "workspace-1",
        userId: "other-user",
        tenantId: "tenant-1",
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      client.head(foreignKey, {
        signal,
        operationId: "operation-3",
        providerInstanceId: "storage-instance-1",
        workspaceId: "workspace-1",
        userId: "user-1",
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await client.close();
  });

  it("bounds streamed downloads and rejects checksum mismatches", async () => {
    const bytes = new TextEncoder().encode("abc");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const fake = fakeS3(async (command) => {
      if (command instanceof PutObjectCommand) return {};
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: bytes.byteLength,
          ContentType: "text/plain",
          ETag: "etag",
          Metadata: { "openmuse-sha256": expectedSha256 },
        };
      }
      if (command instanceof GetObjectCommand) {
        return {
          ContentLength: bytes.byteLength,
          ContentType: "text/plain",
          Body: (async function* () {
            yield new Uint8Array([1, 2, 3]);
            yield new Uint8Array([4]);
          })(),
        };
      }
      throw new Error("unexpected S3 command");
    });
    const driver = runtimeDriver("openmuse-test", undefined, { clientFactory: () => fake });
    const client = await driver.create({ bucket: "openmuse-test", maxObjectBytes: 3 }, context);
    const object = await client.put(
      { key: "bounded.txt", blob: { bytes, contentType: "text/plain" } },
      operation("put"),
    );
    await expect(client.get(object.key, operation("stream-too-large"))).rejects.toMatchObject({
      code: "failed",
    });
    await client.close();

    const mismatch = fakeS3(async (command) => {
      if (command instanceof PutObjectCommand) return {};
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: bytes.byteLength,
          ContentType: "text/plain",
          Metadata: { "openmuse-sha256": expectedSha256 },
        };
      }
      if (command instanceof GetObjectCommand) {
        return {
          ContentLength: bytes.byteLength,
          ContentType: "text/plain",
          Body: new TextEncoder().encode("xyz"),
        };
      }
      throw new Error("unexpected S3 command");
    });
    const mismatchClient = await runtimeDriver("openmuse-test", undefined, {
      clientFactory: () => mismatch,
    }).create({ bucket: "openmuse-test", maxObjectBytes: 3 }, context);
    const mismatchObject = await mismatchClient.put(
      { key: "checksum.txt", blob: { bytes, contentType: "text/plain" } },
      operation("checksum-put"),
    );
    await expect(
      mismatchClient.get(mismatchObject.key, operation("checksum-get")),
    ).rejects.toMatchObject({
      code: "failed",
    });
    await mismatchClient.close();

    const aborted = new AbortController();
    aborted.abort();
    const abortClient = await runtimeDriver("openmuse-test", undefined, {
      clientFactory: () => fake,
    }).create({ bucket: "openmuse-test" }, context);
    await expect(
      abortClient.get(object.key, operation("aborted", { signal: aborted.signal })),
    ).rejects.toMatchObject({ code: "cancelled" });
    await abortClient.close();
  });

  it("does not dispatch a pre-cancelled upload", async () => {
    let sends = 0;
    const fake = fakeS3(async () => {
      sends += 1;
      throw new Error("the pre-cancelled upload must not reach S3");
    });
    const client = await runtimeDriver("openmuse-test", undefined, {
      clientFactory: () => fake,
    }).create({ bucket: "openmuse-test" }, context);
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      client.put(
        {
          key: "pre-cancelled.txt",
          blob: { bytes: new Uint8Array([1]), contentType: "text/plain" },
        },
        operation("pre-cancelled-put", { signal: aborted.signal }),
      ),
    ).rejects.toMatchObject({ code: "cancelled", uncertain: false });
    expect(sends).toBe(0);
    await client.close();
  });

  it("marks an upload uncertain when cancellation arrives after dispatch", async () => {
    let markPutStarted!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    let releasePut!: (value: unknown) => void;
    const fake = fakeS3(async (command) => {
      if (!(command instanceof PutObjectCommand)) throw new Error("unexpected S3 command");
      markPutStarted();
      return new Promise<unknown>((resolve) => {
        releasePut = resolve;
      });
    });
    const client = await runtimeDriver("openmuse-test", undefined, {
      clientFactory: () => fake,
    }).create({ bucket: "openmuse-test" }, context);
    const controller = new AbortController();
    const pending = client.put(
      { key: "uncertain.txt", blob: { bytes: new Uint8Array([1]), contentType: "text/plain" } },
      operation("uncertain-put", { signal: controller.signal }),
    );
    await putStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "unknown_outcome", uncertain: true });
    releasePut({});
    await client.close();
  });

  it("marks a delete uncertain when cancellation arrives after dispatch", async () => {
    let markDeleteStarted!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    let releaseDelete!: (value: unknown) => void;
    const fake = fakeS3(async (command) => {
      if (!(command instanceof DeleteObjectCommand)) throw new Error("unexpected S3 command");
      markDeleteStarted();
      return new Promise<unknown>((resolve) => {
        releaseDelete = resolve;
      });
    });
    const client = await runtimeDriver("openmuse-test", undefined, {
      clientFactory: () => fake,
    }).create({ bucket: "openmuse-test" }, context);
    const objectKey = scopedObjectKey();
    const controller = new AbortController();
    const pending = client.delete(
      objectKey,
      operation("uncertain-delete", { signal: controller.signal }),
    );
    await deleteStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "unknown_outcome", uncertain: true });
    releaseDelete({});
    await client.close();
  });

  it("cancels a hung download stream promptly and closes its iterator", async () => {
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let resolveRead!: (result: IteratorResult<Uint8Array>) => void;
    const readPending = new Promise<IteratorResult<Uint8Array>>((resolve) => {
      resolveRead = resolve;
    });
    let markIteratorReturned!: () => void;
    const iteratorReturned = new Promise<void>((resolve) => {
      markIteratorReturned = resolve;
    });
    const bytes = new Uint8Array([1]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const body = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            markReadStarted();
            return readPending;
          },
          return() {
            markIteratorReturned();
            resolveRead({ done: true, value: undefined });
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    const fake = fakeS3(async (command) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: bytes.byteLength,
          ContentType: "text/plain",
          Metadata: { "openmuse-sha256": sha256 },
        };
      }
      if (command instanceof GetObjectCommand) {
        return { ContentLength: bytes.byteLength, ContentType: "text/plain", Body: body };
      }
      throw new Error("unexpected S3 command");
    });
    const client = await runtimeDriver("openmuse-test", undefined, {
      clientFactory: () => fake,
    }).create({ bucket: "openmuse-test" }, context);
    const objectKey = scopedObjectKey();
    const controller = new AbortController();
    const pending = client.get(objectKey, operation("hung-get", { signal: controller.signal }));
    await readStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "cancelled", uncertain: false });
    await expect(iteratorReturned).resolves.toBeUndefined();
    await client.close();
  });

  it("rejects a GET whose content type changes after HEAD", async () => {
    const bytes = new TextEncoder().encode("mime-integrity");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const fake = fakeS3(async (command) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: bytes.byteLength,
          ContentType: "image/png",
          Metadata: { "openmuse-sha256": sha256 },
        };
      }
      if (command instanceof GetObjectCommand) {
        return {
          ContentLength: bytes.byteLength,
          ContentType: "text/plain",
          Body: bytes,
        };
      }
      throw new Error("unexpected S3 command");
    });
    const client = await runtimeDriver("openmuse-test", undefined, {
      clientFactory: () => fake,
    }).create({ bucket: "openmuse-test" }, context);
    await expect(client.get(scopedObjectKey(), operation("mime-mismatch"))).rejects.toMatchObject({
      code: "failed",
    });
    await client.close();
  });
});
