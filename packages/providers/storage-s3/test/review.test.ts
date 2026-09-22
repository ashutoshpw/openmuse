import { S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProviderCreateContext, ProviderOperationContext } from "@openmuse/provider-contracts";
import { createS3StorageDriver } from "../src/index.js";

function createContext(overrides: Partial<ProviderCreateContext> = {}): ProviderCreateContext {
  return {
    signal: new AbortController().signal,
    scopeId: "review-scope",
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    providerInstanceId: "storage-instance-1",
    ...overrides,
  };
}

function operation(overrides: Partial<ProviderOperationContext> = {}): ProviderOperationContext {
  return {
    signal: new AbortController().signal,
    operationId: crypto.randomUUID(),
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    providerInstanceId: "storage-instance-1",
    ...overrides,
  };
}

function fakeS3(send: (command: unknown) => Promise<unknown>): S3Client {
  return Object.assign(
    new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "review-access", secretAccessKey: "review-secret" },
    }),
    { send, destroy() {} },
  ) as S3Client;
}

function scopedKey(suffix = "a".repeat(43)): string {
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
  return `openmuse/v1/${scope}/${suffix}`;
}

describe("S3 storage independent review", () => {
  it("rejects missing or changed workspace, tenant, actor, and instance bindings", async () => {
    let sends = 0;
    const client = await createS3StorageDriver({
      clientFactory: () =>
        fakeS3(async () => {
          sends += 1;
          return { ContentLength: 0, ContentType: "application/octet-stream" };
        }),
    }).create({ bucket: "review-bucket" }, createContext());

    try {
      const mismatches: Array<
        [Partial<ProviderOperationContext>, "scope_missing" | "permission_denied"]
      > = [
        [{ workspaceId: "workspace-2" }, "permission_denied"],
        [{ tenantId: "tenant-2" }, "permission_denied"],
        [{ userId: "user-2" }, "permission_denied"],
        [{ providerInstanceId: "storage-instance-2" }, "permission_denied"],
        [{ tenantId: undefined }, "permission_denied"],
        [{ workspaceId: undefined }, "scope_missing"],
        [{ userId: undefined }, "scope_missing"],
        [{ providerInstanceId: undefined }, "permission_denied"],
      ];
      for (const [mismatch, code] of mismatches) {
        await expect(client.head(scopedKey(), operation(mismatch))).rejects.toMatchObject({ code });
      }
      expect(sends).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("signs HTML and SVG downloads as octet-stream attachments", async () => {
    const client = await createS3StorageDriver({
      clientFactory: () => fakeS3(async () => ({})),
    }).create({ bucket: "review-bucket", maxSignedUrlSeconds: 60 }, createContext());

    try {
      for (const suffix of ["h".repeat(43), "s".repeat(43)]) {
        const signed = await client.createDownloadUrl(scopedKey(suffix), 30, operation());
        const url = new URL(signed);
        expect(url.searchParams.get("response-content-type")).toBe("application/octet-stream");
        expect(url.searchParams.get("response-content-disposition")).toBe("attachment");
      }
    } finally {
      await client.close();
    }
  });

  it("passes the trusted endpoint and bounded retry policy to the real AWS SDK client", async () => {
    let receivedConfig: Record<string, unknown> | undefined;
    const fake = fakeS3(async () => ({}));
    const driver = createS3StorageDriver({
      trustedEndpoints: ["https://objects.example.test/base/"],
      clientFactory: (config) => {
        receivedConfig = config as Record<string, unknown>;
        return fake;
      },
    });
    const client = await driver.create(
      { bucket: "review-bucket", endpoint: "https://objects.example.test/base" },
      createContext(),
    );

    expect(receivedConfig).toMatchObject({
      endpoint: "https://objects.example.test/base",
      forcePathStyle: true,
      maxAttempts: 1,
    });
    await client.close();
  });
});
