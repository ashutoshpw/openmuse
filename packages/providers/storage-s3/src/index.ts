import { createHash, randomBytes } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  ProviderOperationError,
  type ProviderBlob,
  type ProviderCreateContext,
  type ProviderOperationContext,
  type StorageClient,
  type StorageConfig,
  type StorageDriver,
  type StorageObject,
} from "@openmuse/provider-contracts";
import { z } from "zod";

export const DEFAULT_MAX_OBJECT_BYTES = 10 * 1024 * 1024;
export const HARD_MAX_OBJECT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_SIGNED_URL_SECONDS = 300;
export const HARD_MAX_SIGNED_URL_SECONDS = 900;
export const MAX_CONTENT_TYPE_LENGTH = 255;
export const MAX_LOGICAL_KEY_LENGTH = 512;

const providerId = "s3";
const keyPrefix = "openmuse/v1";
const internalKeyPattern = new RegExp(`^${keyPrefix}/([A-Za-z0-9_-]{43})/([A-Za-z0-9_-]{43})$`);
const sha256Pattern = /^[0-9a-f]{64}$/;
const contentTypeToken = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const metadataKeyPattern = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const maxMetadataValueBytes = 2048;
const maxMetadataBytes = 8192;

export const storageConfigSchema = z
  .object({
    endpoint: z.string().url().optional(),
    bucket: z.string().trim().min(1).max(255),
    region: z.string().trim().min(1).max(255).default("us-east-1"),
    maxObjectBytes: z
      .number()
      .int()
      .min(1)
      .max(HARD_MAX_OBJECT_BYTES)
      .default(DEFAULT_MAX_OBJECT_BYTES),
    maxSignedUrlSeconds: z
      .number()
      .int()
      .min(1)
      .max(HARD_MAX_SIGNED_URL_SECONDS)
      .default(DEFAULT_MAX_SIGNED_URL_SECONDS),
    allowedContentTypes: z
      .array(z.string().trim().min(1).max(MAX_CONTENT_TYPE_LENGTH))
      .max(256)
      .optional(),
  })
  .strict();

export interface StorageS3DriverOptions {
  /** Exact custom endpoints approved by the deployment operator. */
  trustedEndpoints?: readonly string[];
  /** Optional SDK credentials supplied by the trusted runtime, never user config. */
  credentials?: S3ClientConfig["credentials"];
  /** Test/runtime seam; endpoint policy is still checked before this is called. */
  clientFactory?: (config: S3ClientConfig) => S3Client;
}

/**
 * The application currently uses workspace as its canonical tenant boundary.
 * A separate tenant ID is carried and checked when present, but workspace,
 * actor, and provider instance identity are always required.
 */
interface ScopeBinding {
  tenantId?: string;
  workspaceId: string;
  userId: string;
  providerInstanceId: string;
}

export function validateStorageLogicalKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_LOGICAL_KEY_LENGTH ||
    key.trim() !== key ||
    key.includes("\0") ||
    key.includes("/") ||
    key.includes("\\") ||
    key === "." ||
    key === ".." ||
    /^[/?#]/.test(key) ||
    key.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(key)
  ) {
    throw storageError(
      "put",
      "invalid_request",
      "The storage key is not a valid logical key.",
      "The storage key is invalid.",
    );
  }
}

export function validateStorageContentType(contentType: string): string {
  if (typeof contentType !== "string") {
    throw storageError(
      "put",
      "invalid_request",
      "A content type is required.",
      "The content type is invalid.",
    );
  }
  const normalized = contentType.trim();
  const [mediaType] = normalized.split(";", 1);
  const separator = mediaType?.indexOf("/") ?? -1;
  const type = separator >= 0 ? mediaType?.slice(0, separator) : undefined;
  const subtype = separator >= 0 ? mediaType?.slice(separator + 1) : undefined;
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (
    normalized.length === 0 ||
    normalized.length > MAX_CONTENT_TYPE_LENGTH ||
    normalized !== contentType ||
    hasControlCharacter ||
    !type ||
    !subtype ||
    !contentTypeToken.test(type) ||
    !contentTypeToken.test(subtype)
  ) {
    throw storageError(
      "put",
      "invalid_request",
      "The content type must be a valid MIME type.",
      "The content type is invalid.",
    );
  }
  return normalized;
}

export function normalizeTrustedEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw storageError(
      "configure",
      "invalid_request",
      "The storage endpoint must be a valid URL.",
      "The storage endpoint is invalid.",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw storageError(
      "configure",
      "permission_denied",
      "Storage endpoints must be HTTP(S), credential-free, and query-free.",
      "The storage endpoint is not trusted.",
    );
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

function assertTrustedEndpoint(
  endpoint: string | undefined,
  trustedEndpoints: readonly string[] | undefined,
): string | undefined {
  if (endpoint === undefined) return undefined;
  const candidate = normalizeTrustedEndpoint(endpoint);
  const trusted = new Set((trustedEndpoints ?? []).map(normalizeTrustedEndpoint));
  if (!trusted.has(candidate)) {
    throw storageError(
      "configure",
      "permission_denied",
      "The custom storage endpoint is not in the deployment operator allowlist.",
      "The storage endpoint is not trusted.",
    );
  }
  return candidate;
}

function scopeBinding(createContext: ProviderCreateContext): ScopeBinding {
  if (!createContext.workspaceId || !createContext.userId || !createContext.providerInstanceId) {
    throw storageError(
      "configure",
      "scope_missing",
      "Storage requires a workspace, actor, and provider instance binding.",
      "Storage scope is unavailable.",
    );
  }
  return {
    ...(createContext.tenantId === undefined ? {} : { tenantId: createContext.tenantId }),
    workspaceId: createContext.workspaceId,
    userId: createContext.userId,
    providerInstanceId: createContext.providerInstanceId,
  };
}

function assertOperationScope(binding: ScopeBinding, operation: ProviderOperationContext): void {
  if (!operation.workspaceId || !operation.userId) {
    throw storageError(
      "scope",
      "scope_missing",
      "Storage operations require a workspace and actor binding.",
      "Storage scope is unavailable.",
    );
  }
  if (
    operation.workspaceId !== binding.workspaceId ||
    operation.userId !== binding.userId ||
    operation.providerInstanceId !== binding.providerInstanceId ||
    (binding.tenantId !== undefined && operation.tenantId !== binding.tenantId) ||
    (binding.tenantId === undefined && operation.tenantId !== undefined)
  ) {
    throw storageError(
      "scope",
      "permission_denied",
      "The storage operation does not match the provider scope.",
      "The object is not available in this scope.",
    );
  }
  assertNotAborted(operation.signal, "scope");
}

function scopeDigest(binding: ScopeBinding): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        tenantId: binding.tenantId ?? "",
        workspaceId: binding.workspaceId,
        userId: binding.userId,
        providerInstanceId: binding.providerInstanceId,
      }),
    )
    .digest("base64url");
}

function objectKeyFor(scope: string): string {
  return `${keyPrefix}/${scope}/${randomBytes(32).toString("base64url")}`;
}

function assertObjectKey(key: string, expectedScope: string, operation: string): string {
  if (typeof key !== "string" || !internalKeyPattern.test(key)) {
    throw storageError(
      operation,
      "invalid_request",
      "The storage object key must be an opaque provider key.",
      "The object key is invalid.",
    );
  }
  if (!key.startsWith(`${keyPrefix}/${expectedScope}/`)) {
    throw storageError(
      operation,
      "permission_denied",
      "The storage object key belongs to a different provider scope.",
      "The object is not available in this scope.",
    );
  }
  return key;
}

function normalizedMetadata(
  metadata: Record<string, string> | undefined,
  logicalKey: string,
  sha256: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  let size = 0;
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (
      !metadataKeyPattern.test(key) ||
      key.startsWith("openmuse-") ||
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") > maxMetadataValueBytes
    ) {
      throw storageError(
        "put",
        "invalid_request",
        "Storage metadata contains an invalid or reserved field.",
        "Storage metadata is invalid.",
      );
    }
    size += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
    if (size > maxMetadataBytes) {
      throw storageError(
        "put",
        "invalid_request",
        "Storage metadata exceeds the provider limit.",
        "Storage metadata is too large.",
      );
    }
    result[key] = value;
  }
  result["openmuse-sha256"] = sha256;
  result["openmuse-key-digest"] = createHash("sha256").update(logicalKey).digest("hex");
  if (
    Object.entries(result).reduce(
      (total, [key, value]) =>
        total + Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8"),
      0,
    ) > maxMetadataBytes
  ) {
    throw storageError(
      "put",
      "invalid_request",
      "Storage metadata exceeds the provider limit.",
      "Storage metadata is too large.",
    );
  }
  return result;
}

function assertAllowedContentType(contentType: string, allowed: readonly string[] | undefined) {
  const normalized = validateStorageContentType(contentType);
  if (allowed !== undefined && allowed.length > 0 && !allowed.includes(normalized)) {
    throw storageError(
      "content-type",
      "permission_denied",
      "The content type is not allowed by the storage provider policy.",
      "The content type is not allowed.",
    );
  }
  return normalized;
}

function assertNotAborted(signal: AbortSignal, operation: string): void {
  if (signal.aborted)
    throw storageError(
      operation,
      "cancelled",
      "The storage operation was cancelled.",
      "The storage operation was cancelled.",
    );
}

function storageError(
  operation: string,
  code: ConstructorParameters<typeof ProviderOperationError>[0]["code"],
  message: string,
  safeMessage = message,
  cause?: unknown,
): ProviderOperationError {
  return new ProviderOperationError(
    {
      code,
      message,
      safeMessage,
      retryable: code === "unavailable" || code === "rate_limited",
      uncertain: code === "unknown_outcome",
      providerId,
      module: "storage",
      operation,
    },
    cause === undefined ? undefined : { cause },
  );
}

function awsErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { name?: unknown; Code?: unknown; code?: unknown };
  if (typeof value.name === "string") return value.name;
  if (typeof value.Code === "string") return value.Code;
  if (typeof value.code === "string") return value.code;
  return undefined;
}

function awsStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { $metadata?: { httpStatusCode?: number }; statusCode?: number };
  return value.$metadata?.httpStatusCode ?? value.statusCode;
}

function unknownStorageOutcome(operation: string, cause?: unknown): ProviderOperationError {
  return storageError(
    operation,
    "unknown_outcome",
    "The storage write outcome is unknown and must be reconciled before retrying.",
    "The storage write outcome is unknown.",
    cause,
  );
}

function mapAwsError(error: unknown, operation: string, mutating = false): ProviderOperationError {
  if (error instanceof ProviderOperationError) {
    if (mutating && error.code === "cancelled") return unknownStorageOutcome(operation, error);
    return error;
  }
  const code = awsErrorCode(error);
  const status = awsStatus(error);
  if (code === "AbortError" || code === "RequestAbortedError") {
    if (mutating) return unknownStorageOutcome(operation, error);
    return storageError(operation, "cancelled", "The storage operation was cancelled.");
  }
  if (status === 404 || code === "NoSuchKey" || code === "NotFound") {
    return storageError(
      operation,
      "not_found",
      "The storage object was not found.",
      "The object was not found.",
      error,
    );
  }
  if (status === 401 || status === 403 || code === "AccessDenied") {
    return storageError(
      operation,
      "permission_denied",
      "The storage service denied the operation.",
      "The storage operation was denied.",
      error,
    );
  }
  if (status === 429 || (status !== undefined && status >= 500)) {
    if (mutating && status !== undefined && status >= 500)
      return unknownStorageOutcome(operation, error);
    return storageError(
      operation,
      "unavailable",
      "The storage service is temporarily unavailable.",
      "The storage service is temporarily unavailable.",
      error,
    );
  }
  if (mutating && status === undefined) return unknownStorageOutcome(operation, error);
  return storageError(
    operation,
    "failed",
    error instanceof Error ? error.message : "The storage operation failed.",
    "The storage operation failed.",
    error,
  );
}

async function sendCommand<T>(
  send: () => Promise<T>,
  signal: AbortSignal,
  operation: string,
  mutating = false,
): Promise<T> {
  assertNotAborted(signal, operation);
  let pending: Promise<T>;
  try {
    pending = send();
  } catch (error) {
    throw mapAwsError(error, operation, mutating);
  }
  try {
    return await awaitWithAbort(pending, signal, operation);
  } catch (error) {
    throw mapAwsError(error, operation, mutating);
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function base64Sha256(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function validateStoredSha256(value: string | undefined, operation: string): string | undefined {
  if (value === undefined) return undefined;
  if (!sha256Pattern.test(value)) {
    throw storageError(
      operation,
      "failed",
      "The storage object has invalid checksum metadata.",
      "The storage object checksum is invalid.",
    );
  }
  return value.toLowerCase();
}

function storageObjectFromHead(
  key: string,
  output: unknown,
  maxObjectBytes: number,
  allowedContentTypes: readonly string[] | undefined,
): StorageObject {
  const value = output as {
    ContentLength?: number;
    ContentType?: string;
    ETag?: string;
    Metadata?: Record<string, string>;
  };
  const sizeBytes = value.ContentLength;
  if (
    sizeBytes === undefined ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    sizeBytes > maxObjectBytes
  ) {
    throw storageError(
      "head",
      "failed",
      "The storage object exceeds the configured size bound or has no reliable size.",
      "The storage object size is invalid.",
    );
  }
  const contentType = assertAllowedContentType(
    value.ContentType ?? "application/octet-stream",
    allowedContentTypes,
  );
  const sha256 = validateStoredSha256(value.Metadata?.["openmuse-sha256"], "head");
  return {
    key,
    contentType,
    sizeBytes,
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(value.ETag === undefined ? {} : { etag: value.ETag }),
  };
}

function chunkBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("The storage service returned an unsupported body chunk.");
}

function abortError(operation: string): ProviderOperationError {
  return storageError(
    operation,
    "cancelled",
    "The storage operation was cancelled.",
    "The storage operation was cancelled.",
  );
}

function awaitWithAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  operation: string,
): Promise<T> {
  assertNotAborted(signal, operation);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(operation));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function cancelAsyncIterator(iterator: AsyncIterator<unknown>): void {
  if (!iterator.return) return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // The body is already being discarded after an abort or size failure.
  }
}

interface ReadableBody {
  getReader(): {
    read(): Promise<{ done: boolean; value?: unknown }>;
    cancel?(reason?: unknown): Promise<unknown>;
  };
}

async function readBoundedBody(
  body: unknown,
  maxObjectBytes: number,
  signal: AbortSignal,
  operation: string,
): Promise<Uint8Array> {
  assertNotAborted(signal, operation);
  if (body === undefined || body === null) {
    throw storageError(
      operation,
      "failed",
      "The storage service returned an empty body.",
      "The storage response was invalid.",
    );
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const append = (chunkValue: unknown) => {
    assertNotAborted(signal, operation);
    const chunk = chunkBytes(chunkValue);
    total += chunk.byteLength;
    if (total > maxObjectBytes) {
      throw storageError(
        operation,
        "failed",
        "The storage response exceeded the configured object size bound.",
        "The storage object is too large.",
      );
    }
    chunks.push(chunk);
  };

  if (typeof body === "object" && body !== null && Symbol.asyncIterator in body) {
    const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    let completed = false;
    try {
      while (true) {
        const next = await awaitWithAbort(Promise.resolve(iterator.next()), signal, operation);
        if (next.done) {
          completed = true;
          break;
        }
        append(next.value);
      }
    } finally {
      if (!completed) cancelAsyncIterator(iterator);
    }
  } else if (
    typeof body === "object" &&
    body !== null &&
    "getReader" in body &&
    typeof (body as { getReader?: unknown }).getReader === "function"
  ) {
    const reader = (body as ReadableBody).getReader();
    let completed = false;
    try {
      while (true) {
        const next = await awaitWithAbort(reader.read(), signal, operation);
        if (next.done) {
          completed = true;
          break;
        }
        append(next.value);
      }
    } finally {
      if (!completed && reader.cancel)
        void reader.cancel(abortError(operation)).catch(() => undefined);
    }
  } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    append(body);
  } else if (typeof Blob !== "undefined" && body instanceof Blob) {
    if (body.size > maxObjectBytes) {
      throw storageError(
        operation,
        "failed",
        "The storage response exceeded the configured object size bound.",
        "The storage object is too large.",
      );
    }
    append(new Uint8Array(await awaitWithAbort(body.arrayBuffer(), signal, operation)));
  } else {
    throw storageError(
      operation,
      "failed",
      "The storage service returned an unsupported body.",
      "The storage response was invalid.",
    );
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function ensureChecksum(
  bytes: Uint8Array,
  expectedHex: string | undefined,
  expectedBase64: string | undefined,
  operation: string,
): string {
  const actualHex = sha256Hex(bytes);
  if (expectedHex !== undefined && actualHex !== expectedHex.toLowerCase()) {
    throw storageError(
      operation,
      "failed",
      "The downloaded storage object failed checksum verification.",
      "The storage object checksum did not match.",
    );
  }
  if (
    expectedBase64 !== undefined &&
    base64Sha256(Buffer.from(actualHex, "hex")) !== expectedBase64
  ) {
    throw storageError(
      operation,
      "failed",
      "The storage service checksum did not match the downloaded bytes.",
      "The storage object checksum did not match.",
    );
  }
  return actualHex;
}

export function createS3StorageDriver(options: StorageS3DriverOptions = {}): StorageDriver {
  return {
    module: "storage",
    providerId,
    metadata: {
      providerId,
      displayName: "S3-compatible object storage",
      version: "0.1.0",
      configVersion: "1",
      buildDigest: "builtin:s3:0.1.0",
      capabilities: [
        { key: "storage.put" },
        { key: "storage.head" },
        { key: "storage.get" },
        { key: "storage.delete" },
        { key: "storage.download-url" },
      ],
      requiredSecrets: [],
      trusted: true,
    },
    config: { version: "1", schema: storageConfigSchema },
    async create(rawConfig: StorageConfig, createContext: ProviderCreateContext) {
      assertNotAborted(createContext.signal, "configure");
      const config = storageConfigSchema.parse(rawConfig);
      const endpoint = assertTrustedEndpoint(config.endpoint, options.trustedEndpoints);
      const binding = scopeBinding(createContext);
      const expectedScope = scopeDigest(binding);
      const clientConfig: S3ClientConfig = {
        region: config.region,
        maxAttempts: 1,
        ...(endpoint === undefined ? {} : { endpoint, forcePathStyle: true }),
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      };
      const client = options.clientFactory
        ? options.clientFactory(clientConfig)
        : new S3Client(clientConfig);
      let closed = false;
      const ensureOpen = (operation: string) => {
        if (closed) throw storageError(operation, "failed", "The storage client is closed.");
      };
      const scope = (operation: ProviderOperationContext, name: string) => {
        ensureOpen(name);
        assertOperationScope(binding, operation);
      };
      const head = async (
        key: string,
        operation: ProviderOperationContext,
      ): Promise<StorageObject> => {
        scope(operation, "head");
        const objectKey = assertObjectKey(key, expectedScope, "head");
        const response = await sendCommand(
          () =>
            client.send(
              new HeadObjectCommand({
                Bucket: config.bucket,
                Key: objectKey,
                ChecksumMode: "ENABLED",
              }),
              { abortSignal: operation.signal },
            ),
          operation.signal,
          "head",
        );
        return storageObjectFromHead(
          objectKey,
          response,
          config.maxObjectBytes,
          config.allowedContentTypes,
        );
      };
      const get = async (
        key: string,
        operation: ProviderOperationContext,
      ): Promise<ProviderBlob> => {
        scope(operation, "get");
        const objectKey = assertObjectKey(key, expectedScope, "get");
        const metadata = await head(objectKey, operation);
        const response = await sendCommand(
          () =>
            client.send(
              new GetObjectCommand({
                Bucket: config.bucket,
                Key: objectKey,
                ChecksumMode: "ENABLED",
              }),
              { abortSignal: operation.signal },
            ),
          operation.signal,
          "get",
        );
        if (response.ContentLength !== undefined && response.ContentLength !== metadata.sizeBytes) {
          throw storageError(
            "get",
            "failed",
            "The storage object changed while it was being downloaded.",
            "The storage object could not be verified.",
          );
        }
        const bytes = await readBoundedBody(
          response.Body,
          config.maxObjectBytes,
          operation.signal,
          "get",
        );
        if (bytes.byteLength !== metadata.sizeBytes) {
          throw storageError(
            "get",
            "failed",
            "The storage response size did not match its metadata.",
            "The storage object could not be verified.",
          );
        }
        ensureChecksum(bytes, metadata.sha256, response.ChecksumSHA256, "get");
        const contentType = assertAllowedContentType(
          response.ContentType ?? metadata.contentType,
          config.allowedContentTypes,
        );
        if (contentType !== metadata.contentType) {
          throw storageError(
            "get",
            "failed",
            "The storage response content type did not match its metadata.",
            "The storage object could not be verified.",
          );
        }
        return { bytes, contentType };
      };

      return {
        async put(request, operation) {
          scope(operation, "put");
          validateStorageLogicalKey(request.key);
          if (!(request.blob?.bytes instanceof Uint8Array)) {
            throw storageError(
              "put",
              "invalid_request",
              "Storage uploads must provide Uint8Array bytes.",
              "The storage upload is invalid.",
            );
          }
          const contentType = assertAllowedContentType(
            request.blob.contentType,
            config.allowedContentTypes,
          );
          const sizeBytes = request.blob.bytes.byteLength;
          if (sizeBytes > config.maxObjectBytes) {
            throw storageError(
              "put",
              "invalid_request",
              "The storage upload exceeds the configured object size bound.",
              "The storage object is too large.",
            );
          }
          const sha256 = sha256Hex(request.blob.bytes);
          const objectKey = objectKeyFor(expectedScope);
          const metadata = normalizedMetadata(request.metadata, request.key, sha256);
          const response = await sendCommand(
            () =>
              client.send(
                new PutObjectCommand({
                  Bucket: config.bucket,
                  Key: objectKey,
                  Body: request.blob.bytes,
                  ContentLength: sizeBytes,
                  ContentType: contentType,
                  Metadata: metadata,
                }),
                { abortSignal: operation.signal },
              ),
            operation.signal,
            "put",
            true,
          );
          if (
            response.ChecksumSHA256 !== undefined &&
            response.ChecksumSHA256 !== base64Sha256(request.blob.bytes)
          ) {
            throw storageError(
              "put",
              "failed",
              "The storage service returned a mismatched checksum.",
              "The storage object checksum did not match.",
            );
          }
          let stored: StorageObject;
          try {
            stored = await head(objectKey, operation);
          } catch (error) {
            throw unknownStorageOutcome("put", error);
          }
          if (
            stored.sizeBytes !== sizeBytes ||
            stored.sha256 !== sha256 ||
            stored.contentType !== contentType
          ) {
            throw storageError(
              "put",
              "failed",
              "The stored object did not match the upload metadata.",
              "The storage object could not be verified.",
            );
          }
          return stored;
        },
        head,
        get,
        async delete(key, operation) {
          scope(operation, "delete");
          const objectKey = assertObjectKey(key, expectedScope, "delete");
          await sendCommand(
            () =>
              client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey }), {
                abortSignal: operation.signal,
              }),
            operation.signal,
            "delete",
            true,
          );
        },
        async createDownloadUrl(key, expiresInSeconds, operation) {
          scope(operation, "download-url");
          const objectKey = assertObjectKey(key, expectedScope, "download-url");
          if (
            !Number.isSafeInteger(expiresInSeconds) ||
            expiresInSeconds < 1 ||
            expiresInSeconds > config.maxSignedUrlSeconds
          ) {
            throw storageError(
              "download-url",
              "invalid_request",
              "The requested signed URL lifetime exceeds the provider policy.",
              "The signed URL lifetime is invalid.",
            );
          }
          assertNotAborted(operation.signal, "download-url");
          try {
            return await getSignedUrl(
              client,
              new GetObjectCommand({
                Bucket: config.bucket,
                Key: objectKey,
                ResponseContentDisposition: "attachment",
                ResponseContentType: "application/octet-stream",
              }),
              { expiresIn: expiresInSeconds },
            );
          } catch (error) {
            throw mapAwsError(error, "download-url");
          }
        },
        async close() {
          if (closed) return;
          closed = true;
          client.destroy();
        },
      } satisfies StorageClient;
    },
  };
}

export { internalKeyPattern as storageInternalKeyPattern };
