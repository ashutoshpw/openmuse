import { randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createS3StorageDriver } from "../src/index.js";

const execFile = promisify(execFileCallback);
const enabled = process.env.OPENMUSE_MINIO_SMOKE === "1";
const required = process.env.OPENMUSE_SMOKE_REQUIRED === "1";
const minioImage =
  "quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const accessKey = "openmuse-smoke-access";
const secretKey = "openmuse-smoke-secret-123456789";

async function docker(args: readonly string[]): Promise<string> {
  const result = await execFile("docker", [...args], { maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}

async function waitForMinio(endpoint: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/minio/health/live`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The container may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("MinIO did not become healthy in time");
}

async function freeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Could not allocate a local port");
  return address.port;
}

function operationFor(operationId: string, providerInstanceId: string) {
  return {
    signal: new AbortController().signal,
    operationId,
    providerInstanceId,
    tenantId: "tenant-smoke",
    workspaceId: "workspace-smoke",
    userId: "user-smoke",
  };
}

describe("S3 storage disposable MinIO integration", () => {
  (enabled || required ? it : it.skipIf(true))(
    "enforces lifecycle, checksums, bounds, scope, and short signed GET URLs",
    async () => {
      const container = `openmuse-minio-storage-${process.pid}-${randomBytes(4).toString("hex")}`;
      let client:
        | Awaited<ReturnType<ReturnType<typeof createS3StorageDriver>["create"]>>
        | undefined;
      let bucket: string | undefined;
      let endpoint: string | undefined;
      let objectKey: string | undefined;
      try {
        const apiPort = await freeLocalPort();
        await docker([
          "run",
          "--detach",
          "--rm",
          "--name",
          container,
          "--publish",
          `127.0.0.1:${apiPort}:${apiPort}`,
          "--env",
          `MINIO_ROOT_USER=${accessKey}`,
          "--env",
          `MINIO_ROOT_PASSWORD=${secretKey}`,
          minioImage,
          "server",
          "/data",
          "--console-address",
          `:${apiPort + 1}`,
          "--address",
          `:${apiPort}`,
        ]);
        endpoint = `http://127.0.0.1:${apiPort}`;
        await waitForMinio(endpoint);
        bucket = `openmuse-smoke-${process.pid}-${Date.now().toString(36)}`;
        const bootstrap = new S3Client({
          region: "us-east-1",
          endpoint,
          forcePathStyle: true,
          credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
        });
        await bootstrap.send(new CreateBucketCommand({ Bucket: bucket }));
        bootstrap.destroy();

        const driver = createS3StorageDriver({
          trustedEndpoints: [endpoint],
          credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
          trustedTargets: [{ endpoint, bucket }],
        });
        const createContext = {
          signal: new AbortController().signal,
          scopeId: "minio-smoke",
          tenantId: "tenant-smoke",
          workspaceId: "workspace-smoke",
          userId: "user-smoke",
          providerInstanceId: "storage-instance-smoke",
        } as const;
        client = await driver.create(
          {
            endpoint,
            bucket,
            maxObjectBytes: 64,
            maxSignedUrlSeconds: 5,
            allowedContentTypes: ["text/plain"],
          },
          createContext,
        );
        const operation = (operationId: string) =>
          operationFor(operationId, "storage-instance-smoke");
        const bytes = new TextEncoder().encode("hello storage");
        const object = await client.put(
          {
            key: "greeting.txt",
            blob: { bytes, contentType: "text/plain" },
            metadata: { purpose: "smoke" },
          },
          operation("put"),
        );
        objectKey = object.key;
        expect(object.key).not.toBe("greeting.txt");
        expect(object).toMatchObject({
          contentType: "text/plain",
          sizeBytes: bytes.byteLength,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        await expect(client.head(object.key, operation("head"))).resolves.toEqual(object);
        await expect(client.get(object.key, operation("get"))).resolves.toEqual({
          bytes,
          contentType: "text/plain",
        });

        const signedUrl = await client.createDownloadUrl(object.key, 5, operation("sign"));
        expect(new URL(signedUrl).searchParams.get("X-Amz-Expires")).toBe("5");
        await expect(
          fetch(signedUrl).then(async (response) => [response.status, await response.text()]),
        ).resolves.toEqual([200, "hello storage"]);
        await expect(
          client.createDownloadUrl(object.key, 6, operation("too-long")),
        ).rejects.toMatchObject({
          code: "invalid_request",
        });
        await expect(
          client.put(
            {
              key: "wrong-content-type",
              blob: { bytes: new Uint8Array([1]), contentType: "image/png" },
            },
            operation("content-type"),
          ),
        ).rejects.toMatchObject({ code: "permission_denied" });
        await expect(
          client.put(
            { key: "too-large", blob: { bytes: new Uint8Array(65), contentType: "text/plain" } },
            operation("too-large"),
          ),
        ).rejects.toMatchObject({ code: "invalid_request" });
        await expect(
          client.put(
            { key: "../escape", blob: { bytes: new Uint8Array([1]), contentType: "text/plain" } },
            operation("path"),
          ),
        ).rejects.toMatchObject({ code: "invalid_request" });
        await expect(
          client.head("https://attacker.example/object", operation("url-key")),
        ).rejects.toMatchObject({ code: "invalid_request" });

        const otherClient = await driver.create(
          {
            endpoint,
            bucket,
            maxObjectBytes: 64,
            maxSignedUrlSeconds: 5,
            allowedContentTypes: ["text/plain"],
          },
          { ...createContext, userId: "other-user" },
        );
        await expect(otherClient.get(object.key, operation("cross-scope"))).rejects.toMatchObject({
          code: "permission_denied",
        });
        await otherClient.close();

        await client.delete(object.key, operation("delete"));
        await expect(client.head(object.key, operation("missing-head"))).rejects.toMatchObject({
          code: "not_found",
        });
        await expect(client.get(object.key, operation("missing-get"))).rejects.toMatchObject({
          code: "not_found",
        });
      } finally {
        await client?.close().catch(() => undefined);
        if (endpoint && bucket) {
          const cleanup = new S3Client({
            region: "us-east-1",
            endpoint,
            forcePathStyle: true,
            credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
          });
          if (objectKey) {
            await cleanup
              .send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }))
              .catch(() => undefined);
          }
          await cleanup.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
          cleanup.destroy();
        }
        await docker(["rm", "--force", container]).catch(() => undefined);
      }
    },
    60_000,
  );
});
