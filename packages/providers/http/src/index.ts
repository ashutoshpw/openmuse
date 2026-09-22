import {
  ProviderOperationError,
  normalizeProviderError,
  redactProviderDetails,
  type JsonObject,
  type ProviderModule,
} from "@openmuse/provider-contracts";

export interface FetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface HttpClientOptions {
  baseUrl: string;
  fetch: FetchLike;
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  defaultTimeoutMs?: number;
}

export interface HttpRequestOptions {
  method?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** A network failure after a write may have an unknown provider outcome. */
  uncertainOnNetworkFailure?: boolean;
}

export interface HttpRequestContext {
  providerId: string;
  module: ProviderModule;
  operation: string;
}

export interface StreamOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  maxDurationMs?: number;
}

export interface HttpClient {
  request(options: HttpRequestOptions, context: HttpRequestContext): Promise<Response>;
  json<T>(
    options: HttpRequestOptions,
    context: HttpRequestContext,
    parse: (value: unknown) => T | PromiseLike<T>,
  ): Promise<T>;
  bytes(options: HttpRequestOptions, context: HttpRequestContext): Promise<Uint8Array>;
  sse(
    response: Response,
    options: StreamOptions,
    context: HttpRequestContext,
  ): AsyncIterable<string>;
  ndjson(
    response: Response,
    options: StreamOptions,
    context: HttpRequestContext,
  ): AsyncIterable<string>;
}

function providerError(
  context: HttpRequestContext,
  code: ConstructorParameters<typeof ProviderOperationError>[0]["code"],
  message: string,
  safeMessage: string,
  extra: Partial<ConstructorParameters<typeof ProviderOperationError>[0]> = {},
): ProviderOperationError {
  return new ProviderOperationError({
    code,
    message,
    safeMessage,
    retryable: false,
    uncertain: false,
    providerId: context.providerId,
    module: context.module,
    operation: context.operation,
    ...extra,
  });
}

function statusCode(
  status: number,
): ConstructorParameters<typeof ProviderOperationError>[0]["code"] {
  if (status === 401) return "authentication_required";
  if (status === 403) return "permission_denied";
  if (status === 404) return "not_found";
  if (status === 408 || status === 425 || status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "invalid_request";
  return "failed";
}

function timeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal?: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  if (timeoutMs === undefined)
    return parent === undefined
      ? { timedOut: () => false, cleanup: () => undefined }
      : { signal: parent, timedOut: () => false, cleanup: () => undefined };
  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

async function* streamLines(
  response: Response,
  streamOptions: StreamOptions,
  context: HttpRequestContext,
  separator: "sse" | "ndjson",
): AsyncIterable<string> {
  if (!response.body)
    throw providerError(
      context,
      "failed",
      "Provider response did not contain a stream.",
      "The provider returned an invalid stream.",
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const started = Date.now();
  const maxBytes = streamOptions.maxBytes ?? 5 * 1024 * 1024;
  const maxDurationMs = streamOptions.maxDurationMs ?? 120_000;
  let totalBytes = 0;
  let buffer = "";
  let dataLines: string[] = [];
  const abortReader = () => {
    void reader.cancel();
  };
  streamOptions.signal?.addEventListener("abort", abortReader, { once: true });
  try {
    while (true) {
      if (streamOptions.signal?.aborted)
        throw providerError(
          context,
          "cancelled",
          "The provider stream was cancelled.",
          "The provider stream was cancelled.",
        );
      const remaining = maxDurationMs - (Date.now() - started);
      if (remaining <= 0)
        throw providerError(
          context,
          "timeout",
          "The provider stream exceeded its time limit.",
          "The provider stream timed out.",
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                providerError(
                  context,
                  "timeout",
                  "The provider stream exceeded its time limit.",
                  "The provider stream timed out.",
                ),
              ),
            remaining,
          );
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (streamOptions.signal?.aborted)
        throw providerError(
          context,
          "cancelled",
          "The provider stream was cancelled.",
          "The provider stream was cancelled.",
        );
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes)
        throw providerError(
          context,
          "failed",
          "The provider stream exceeded its size limit.",
          "The provider response was too large.",
        );
      buffer += decoder.decode(result.value, { stream: true });
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (separator === "ndjson") {
          if (line.trim()) yield line;
          continue;
        }
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        if (line === "" && dataLines.length > 0) {
          const data = dataLines.join("\n");
          dataLines = [];
          yield data;
        }
      }
    }
    buffer += decoder.decode();
    if (separator === "ndjson" && buffer.trim()) yield buffer.trim();
    if (separator === "sse" && buffer.startsWith("data:"))
      dataLines.push(buffer.slice(5).trimStart());
    if (separator === "sse" && dataLines.length > 0) yield dataLines.join("\n");
  } catch (error) {
    if (error instanceof ProviderOperationError) throw error;
    if (isAbort(error, streamOptions.signal))
      throw providerError(
        context,
        "cancelled",
        "The provider stream was cancelled.",
        "The provider stream was cancelled.",
      );
    throw normalizeProviderError(error, {
      providerId: context.providerId,
      module: context.module,
      operation: context.operation,
    });
  } finally {
    streamOptions.signal?.removeEventListener("abort", abortReader);
    await reader.cancel().catch(() => undefined);
  }
}

async function responseDetails(
  response: Response,
): Promise<{ providerCode?: string; safeMessage?: string; details: JsonObject }> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return { details: { status: response.status } };
  const raw = await response
    .clone()
    .text()
    .then((value) => value.slice(0, 16_384))
    .catch(() => "");
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { details: { status: response.status } };
  const record = parsed as Record<string, unknown>;
  const providerCode =
    typeof record.code === "string"
      ? record.code
      : typeof record.error === "string"
        ? record.error
        : undefined;
  const rawMessage =
    typeof record.message === "string"
      ? record.message
      : typeof record.error_description === "string"
        ? record.error_description
        : undefined;
  const safeMessage = rawMessage
    ? String(redactProviderDetails(rawMessage)).slice(0, 500)
    : undefined;
  const details: JsonObject = { status: response.status };
  if (providerCode) details.providerCode = providerCode;
  return {
    ...(providerCode ? { providerCode } : {}),
    ...(safeMessage ? { safeMessage } : {}),
    details,
  };
}

function bodyInit(value: unknown): BodyInit | undefined {
  if (value === undefined) return undefined;
  if (
    value instanceof FormData ||
    value instanceof Blob ||
    value instanceof ArrayBuffer ||
    value instanceof URLSearchParams ||
    typeof value === "string"
  )
    return value;
  if (value instanceof Uint8Array) return value as unknown as BodyInit;
  return JSON.stringify(value);
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const defaultTimeoutMs = options.defaultTimeoutMs;

  async function request(
    requestOptions: HttpRequestOptions,
    context: HttpRequestContext,
  ): Promise<Response> {
    const timeout = timeoutSignal(
      requestOptions.signal,
      requestOptions.timeoutMs ?? defaultTimeoutMs,
    );
    try {
      const headers = new Headers(
        typeof options.headers === "function" ? await options.headers() : options.headers,
      );
      for (const [key, value] of Object.entries(requestOptions.headers ?? {}))
        headers.set(key, value);
      const body = bodyInit(requestOptions.body);
      if (
        body !== undefined &&
        typeof requestOptions.body !== "string" &&
        !(requestOptions.body instanceof FormData) &&
        !(requestOptions.body instanceof Blob) &&
        !(requestOptions.body instanceof ArrayBuffer) &&
        !(requestOptions.body instanceof URLSearchParams) &&
        !(requestOptions.body instanceof Uint8Array)
      ) {
        headers.set("Content-Type", "application/json");
      }
      const init: RequestInit = {
        method: requestOptions.method ?? "GET",
        headers,
        redirect: "error",
      };
      if (body !== undefined) init.body = body;
      if (timeout.signal !== undefined) init.signal = timeout.signal;
      const response = await options.fetch(
        `${baseUrl}${requestOptions.path.startsWith("/") ? requestOptions.path : `/${requestOptions.path}`}`,
        init,
      );
      if (!response.ok) {
        const details = await responseDetails(response);
        const retryAfterValue = Number(response.headers.get("retry-after"));
        throw new ProviderOperationError({
          code: statusCode(response.status),
          message: details.safeMessage ?? `Provider returned HTTP ${response.status}.`,
          safeMessage: "The provider rejected the request.",
          retryable:
            response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500,
          uncertain: false,
          providerId: context.providerId,
          module: context.module,
          operation: context.operation,
          ...(details.providerCode ? { providerCode: details.providerCode } : {}),
          details: details.details,
          ...(Number.isFinite(retryAfterValue) && retryAfterValue > 0
            ? { retryAfterSeconds: retryAfterValue }
            : {}),
        });
      }
      return response;
    } catch (error) {
      if (error instanceof ProviderOperationError) throw error;
      if (timeout.timedOut()) {
        throw providerError(
          context,
          "timeout",
          "The provider request exceeded its time limit.",
          "The provider request timed out.",
        );
      }
      if (isAbort(error, timeout.signal ?? requestOptions.signal)) {
        throw providerError(
          context,
          "cancelled",
          "The provider request was cancelled.",
          "The provider request was cancelled.",
        );
      }
      throw normalizeProviderError(error, {
        providerId: context.providerId,
        module: context.module,
        operation: context.operation,
        uncertain: requestOptions.uncertainOnNetworkFailure === true,
      });
    } finally {
      timeout.cleanup();
    }
  }

  async function json<T>(
    requestOptions: HttpRequestOptions,
    context: HttpRequestContext,
    parse: (value: unknown) => T | PromiseLike<T>,
  ): Promise<T> {
    const response = await request(requestOptions, context);
    const raw = await response.text().catch(() => "");
    if (
      requestOptions.maxResponseBytes !== undefined &&
      new TextEncoder().encode(raw).byteLength > requestOptions.maxResponseBytes
    ) {
      throw providerError(
        context,
        "failed",
        "Provider response exceeded its size limit.",
        "The provider response was too large.",
      );
    }
    let value: unknown;
    try {
      value = raw.length === 0 ? undefined : JSON.parse(raw);
    } catch (error) {
      throw providerError(
        context,
        "failed",
        error instanceof Error ? error.message : "Invalid JSON response.",
        "The provider returned an invalid response.",
      );
    }
    try {
      return await parse(value);
    } catch (error) {
      throw providerError(
        context,
        "failed",
        error instanceof Error ? error.message : "Response schema mismatch.",
        "The provider returned an invalid response.",
      );
    }
  }

  async function bytes(
    requestOptions: HttpRequestOptions,
    context: HttpRequestContext,
  ): Promise<Uint8Array> {
    const response = await request(requestOptions, context);
    const responseBytes = new Uint8Array(await response.arrayBuffer());
    if (
      requestOptions.maxResponseBytes !== undefined &&
      responseBytes.byteLength > requestOptions.maxResponseBytes
    ) {
      throw providerError(
        context,
        "failed",
        "Provider response exceeded its size limit.",
        "The provider response was too large.",
      );
    }
    return responseBytes;
  }

  return {
    request,
    json,
    bytes,
    sse: (response, streamOptions, context) => streamLines(response, streamOptions, context, "sse"),
    ndjson: (response, streamOptions, context) =>
      streamLines(response, streamOptions, context, "ndjson"),
  };
}

export function asRecord(value: unknown, context: HttpRequestContext): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw providerError(
      context,
      "failed",
      "Expected an object response.",
      "The provider returned an invalid response.",
    );
  return value as Record<string, unknown>;
}

export function asString(value: unknown, field: string, context: HttpRequestContext): string {
  if (typeof value !== "string" || value.length === 0)
    throw providerError(
      context,
      "failed",
      `Expected response field ${field}.`,
      "The provider returned an invalid response.",
    );
  return value;
}

export function asFiniteNumber(value: unknown, field: string, context: HttpRequestContext): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw providerError(
      context,
      "failed",
      `Expected response field ${field}.`,
      "The provider returned an invalid response.",
    );
  return value;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is required for provenance hashing.");
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
