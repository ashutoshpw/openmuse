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

const signal = new AbortController().signal;
const context = {
  signal,
  scopeId: "storage-test",
  tenantId: "tenant-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  providerInstanceId: "storage-instance-1",
} as const;

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
  return Object.assign(new S3Client({ region: "us-east-1" }), {
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

  it("does not allow an operation to omit a bound tenant or switch actor", async () => {
    const driver = createS3StorageDriver({
      clientFactory: () => new S3Client({ region: "us-east-1" }),
    });
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
    const driver = createS3StorageDriver({ clientFactory: () => fake });
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
    const mismatchClient = await createS3StorageDriver({
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
    const abortClient = await createS3StorageDriver({
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
    const client = await createS3StorageDriver({ clientFactory: () => fake }).create(
      { bucket: "openmuse-test" },
      context,
    );
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
    const client = await createS3StorageDriver({ clientFactory: () => fake }).create(
      { bucket: "openmuse-test" },
      context,
    );
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
    const client = await createS3StorageDriver({ clientFactory: () => fake }).create(
      { bucket: "openmuse-test" },
      context,
    );
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
    const client = await createS3StorageDriver({ clientFactory: () => fake }).create(
      { bucket: "openmuse-test" },
      context,
    );
    const objectKey = scopedObjectKey();
    const controller = new AbortController();
    const pending = client.get(objectKey, operation("hung-get", { signal: controller.signal }));
    await readStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "cancelled", uncertain: false });
    await expect(iteratorReturned).resolves.toBeUndefined();
    await client.close();
  });
});
