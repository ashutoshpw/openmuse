import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DockerContainer,
  DockerContainerSpec,
  DockerExecRequest,
  DockerRuntime,
} from "@openmuse/provider-sandbox-docker";
import { DockerUnknownOutcomeError } from "@openmuse/provider-sandbox-docker";
import type { SandboxFile, SandboxScopeClaims } from "@openmuse/provider-contracts";

export interface SandboxServiceOptions {
  runtime: DockerRuntime;
  /** Shared HMAC secret. It is never accepted as a bearer credential itself. */
  serviceToken: string;
  workspaceId: string;
  providerId: string;
  instanceId: string;
  userId?: string;
  maxBodyBytes?: number;
  maxFileBytes?: number;
  maxExecSeconds?: number;
  requestTimeoutMs?: number;
  allowedImages: readonly string[];
}

type SandboxServiceScope = Pick<
  SandboxServiceOptions,
  "workspaceId" | "providerId" | "instanceId" | "userId"
>;

interface JsonBody {
  [key: string]: unknown;
}

interface RequestSignalState {
  readonly controller: AbortController;
  readonly onAborted: () => void;
  readonly onSocketClose: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const requestSignals = new WeakMap<IncomingMessage, RequestSignalState>();
const envKey = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const digestImage = /^[^@\s]+@sha256:[0-9a-f]{64}$/i;

export function createSandboxService(options: SandboxServiceOptions) {
  const serviceToken = options.serviceToken;
  const scope: SandboxServiceScope = Object.freeze({
    workspaceId: options.workspaceId,
    providerId: options.providerId,
    instanceId: options.instanceId,
    ...(options.userId ? { userId: options.userId } : {}),
  });
  const allowedImages = Object.freeze([...options.allowedImages]);
  if (!serviceToken.trim()) throw new Error("SANDBOX_SERVICE_TOKEN is required.");
  if (!scope.workspaceId.trim() || !scope.providerId.trim() || !scope.instanceId.trim())
    throw new Error("Sandbox service scope binding is required.");
  if (allowedImages.length === 0) throw new Error("Sandbox service image allowlist is required.");
  if (allowedImages.some((image) => !digestImage.test(image)))
    throw new Error("Sandbox service image allowlist must contain digest-pinned images.");
  const maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
  const maxBodyBytes =
    options.maxBodyBytes ??
    Math.max(16 * 1024 * 1024, Math.ceil((maxFileBytes * 4) / 3) + 64 * 1024);
  const maxExecSeconds = options.maxExecSeconds ?? 15 * 60;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? Math.max(30_000, (maxExecSeconds + 30) * 1000);
  if (
    !Number.isFinite(maxFileBytes) ||
    !Number.isInteger(maxFileBytes) ||
    maxFileBytes <= 0 ||
    maxFileBytes > 100 * 1024 * 1024 ||
    !Number.isFinite(maxBodyBytes) ||
    !Number.isInteger(maxBodyBytes) ||
    maxBodyBytes <= 0 ||
    maxBodyBytes > 200 * 1024 * 1024 ||
    !Number.isFinite(maxExecSeconds) ||
    !Number.isInteger(maxExecSeconds) ||
    maxExecSeconds <= 0 ||
    maxExecSeconds > 15 * 60 ||
    !Number.isFinite(requestTimeoutMs) ||
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < maxExecSeconds * 1000
  )
    throw new Error("Sandbox service limits must be finite and allow the configured exec timeout.");

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const signal = requestSignal(request, requestTimeoutMs);
    try {
      const claims = await authorized(request.headers.authorization, serviceToken, scope);
      if (!claims) {
        json(response, 401, { error: "Sandbox service authentication required." });
        return;
      }
      const url = new URL(request.url ?? "/", "http://sandbox-service.local");
      const route = decodeRoute(url.pathname);
      if (
        request.method === "GET" &&
        route.length === 3 &&
        route[0] === "v1" &&
        route[1] === "sandboxes"
      ) {
        const container = await ownedContainer(route[2]!, claims, signal, options.runtime);
        json(response, 200, await abortable(() => container.inspect(signal), signal));
        return;
      }
      if (
        route.length === 2 &&
        route[0] === "v1" &&
        route[1] === "sandboxes" &&
        request.method === "POST"
      ) {
        const body = await readJson(request, maxBodyBytes, signal);
        const spec = parseSpec(body, claims, allowedImages, maxExecSeconds);
        const container = await options.runtime.create(spec, signal);
        json(response, 201, { id: container.id });
        return;
      }
      if (route.length >= 4 && route[0] === "v1" && route[1] === "sandboxes") {
        const id = route[2]!;
        const container = await ownedContainer(id, claims, signal, options.runtime);
        if (route[3] === "exec" && request.method === "POST") {
          const body = await readJson(request, maxBodyBytes, signal);
          const operationId = requiredString(body.operationId, "operationId", 256);
          const exec = parseExec(body, operationId, signal, maxExecSeconds);
          const result = await container.exec(exec);
          json(response, 200, result);
          return;
        }
        if (route[3] === "files" && route[4] === "read" && request.method === "POST") {
          const body = await readJson(request, maxBodyBytes, signal);
          const bytes = await container.readFile(requiredString(body.path, "path", 256), signal);
          if (bytes.byteLength > maxFileBytes)
            throw new HttpError(413, "Sandbox file exceeds the service size limit.");
          json(response, 200, { bytesBase64: toBase64(bytes) });
          return;
        }
        if (route[3] === "files" && route[4] === "write" && request.method === "POST") {
          const body = await readJson(request, maxBodyBytes, signal);
          const encoded = requiredString(
            body.bytesBase64,
            "bytesBase64",
            Math.ceil((maxFileBytes * 4) / 3) + 4,
          );
          const file: SandboxFile = {
            path: requiredString(body.path, "path", 256),
            bytes: fromBase64(encoded, maxFileBytes),
            ...(typeof body.contentType === "string" ? { contentType: body.contentType } : {}),
          };
          await container.writeFile(file, signal);
          json(response, 204, undefined);
          return;
        }
        if (route[3] === "operations" && route[5] === "cancel" && request.method === "POST") {
          await abortable(
            () =>
              container.cancel?.(requiredString(route[4], "operationId", 256), signal) ??
              Promise.resolve(),
            signal,
          );
          json(response, 204, undefined);
          return;
        }
        throw new HttpError(404, "Sandbox service route not found.");
      }
      if (
        route.length === 3 &&
        route[0] === "v1" &&
        route[1] === "sandboxes" &&
        request.method === "DELETE"
      ) {
        const container = await ownedContainer(route[2]!, claims, signal, options.runtime);
        await abortable(() => container.destroy("service delete", signal), signal);
        json(response, 204, undefined);
        return;
      }
      throw new HttpError(404, "Sandbox service route not found.");
    } catch (cause) {
      const status = cause instanceof HttpError ? cause.status : signal.aborted ? 408 : 500;
      if (!response.headersSent)
        json(response, status, {
          error: safeMessage(cause),
          ...(isUnknownOutcome(cause) ? { code: "unknown_outcome" } : {}),
        });
    } finally {
      releaseRequestSignal(request);
    }
  };
}

async function ownedContainer(
  id: string,
  claims: SandboxScopeClaims,
  signal: AbortSignal,
  runtime: DockerRuntime,
): Promise<DockerContainer> {
  const container = await abortable(() => runtime.get(id, signal), signal);
  const inspection = await abortable(() => container.inspect(signal), signal);
  if (
    inspection.labels["openmuse.workspace_id"] !== claims.workspaceId ||
    inspection.labels["openmuse.provider"] !== claims.providerId ||
    inspection.labels["openmuse.instance_id"] !== claims.instanceId ||
    inspection.labels["openmuse.user_id"] !== (claims.userId ?? "")
  )
    throw new HttpError(403, "Sandbox scope binding mismatch.");
  return container;
}

function parseSpec(
  body: JsonBody,
  claims: SandboxScopeClaims,
  allowedImages: readonly string[],
  maxExecSeconds: number,
): DockerContainerSpec {
  if (
    typeof body.image !== "string" ||
    !digestImage.test(body.image) ||
    !allowedImages.includes(body.image) ||
    body.networkDisabled !== true ||
    body.privileged !== false ||
    !Array.isArray(body.mounts) ||
    body.mounts.length !== 0
  )
    throw new HttpError(
      400,
      "Only allowlisted, digest-pinned, network-disabled, mount-free sandboxes are supported.",
    );
  const labels = parseStringMap(body.labels, "labels");
  if (
    labels["openmuse.workspace_id"] !== claims.workspaceId ||
    labels["openmuse.provider"] !== claims.providerId ||
    labels["openmuse.instance_id"] !== claims.instanceId ||
    labels["openmuse.user_id"] !== (claims.userId ?? "")
  )
    throw new HttpError(403, "Sandbox scope binding mismatch.");
  if (!body.limits || typeof body.limits !== "object" || Array.isArray(body.limits))
    throw new HttpError(400, "Sandbox limits are required.");
  const limits = parseLimits(body.limits, maxExecSeconds);
  return {
    image: body.image,
    labels,
    limits,
    networkDisabled: true,
    privileged: false,
    mounts: [],
  };
}

function parseExec(
  body: JsonBody,
  operationId: string,
  signal: AbortSignal,
  maxExecSeconds: number,
): DockerExecRequest {
  if (
    !Array.isArray(body.argv) ||
    body.argv.length === 0 ||
    body.argv.some((value) => typeof value !== "string" || value.length > 64 * 1024)
  )
    throw new HttpError(400, "Sandbox argv must be a non-empty string array.");
  if (body.cwd !== undefined && typeof body.cwd !== "string")
    throw new HttpError(400, "cwd must be a string.");
  const env =
    body.env && typeof body.env === "object" && !Array.isArray(body.env)
      ? parseStringMap(body.env, "env")
      : undefined;
  const timeoutSeconds = body.timeoutSeconds === undefined ? undefined : body.timeoutSeconds;
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== "number" ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds <= 0 ||
      timeoutSeconds > maxExecSeconds)
  )
    throw new HttpError(400, "timeoutSeconds exceeds the service limit.");
  return {
    argv: body.argv,
    ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
    ...(env ? { env } : {}),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    operationId,
    signal,
  };
}

function parseLimits(value: object, maxExecSeconds: number): DockerContainerSpec["limits"] {
  const allowed = ["cpu", "memoryMb", "diskMb", "pids", "timeoutSeconds"] as const;
  const result: DockerContainerSpec["limits"] = {};
  for (const key of allowed) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) continue;
    if (
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      item <= 0 ||
      ((["memoryMb", "diskMb", "pids"] as readonly string[]).includes(key) &&
        !Number.isInteger(item))
    )
      throw new HttpError(400, `limits.${key} must be a finite positive number.`);
    if (key === "timeoutSeconds" && item > maxExecSeconds)
      throw new HttpError(400, "limits.timeoutSeconds exceeds the service limit.");
    const maximum =
      key === "cpu"
        ? 8
        : key === "memoryMb"
          ? 16_384
          : key === "diskMb"
            ? 100_000
            : key === "pids"
              ? 4_096
              : maxExecSeconds;
    if (item > maximum) throw new HttpError(400, `limits.${key} exceeds the service limit.`);
    result[key] = item;
  }
  return result;
}

function parseStringMap(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, `${field} must be an object.`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      (field === "env" && !envKey.test(key)) ||
      typeof item !== "string" ||
      key.length > 128 ||
      item.length > 64 * 1024 ||
      item.includes("\0")
    )
      throw new HttpError(400, `${field} contains an invalid value.`);
    result[key] = item;
  }
  return result;
}

function decodeRoute(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        throw new HttpError(400, "Sandbox service route is invalid.");
      }
    });
}

function requestSignal(request: IncomingMessage, timeoutMs = 30_000): AbortSignal {
  const existing = requestSignals.get(request);
  if (existing) return existing.controller.signal;
  const controller = new AbortController();
  const abortRequest = (reason: string) => {
    controller.abort(reason);
    // A body iterator can otherwise wait forever for the rest of a partial
    // request. Destroy only incomplete request streams so completed requests
    // can still receive a bounded operation response.
    if (!request.complete && !request.destroyed) request.destroy();
  };
  const onAborted = () => abortRequest("client disconnected");
  const onSocketClose = () => abortRequest("client disconnected");
  const timer = setTimeout(() => abortRequest("request deadline"), timeoutMs);
  request.once("aborted", onAborted);
  request.socket.once("close", onSocketClose);
  const state = { controller, onAborted, onSocketClose, timer };
  requestSignals.set(request, state);
  return controller.signal;
}

function releaseRequestSignal(request: IncomingMessage): void {
  const state = requestSignals.get(request);
  if (!state) return;
  clearTimeout(state.timer);
  request.removeListener("aborted", state.onAborted);
  request.socket.removeListener("close", state.onSocketClose);
  requestSignals.delete(request);
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<JsonBody> {
  if (signal.aborted) throw new HttpError(408, "Sandbox service request deadline exceeded.");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      if (signal.aborted) throw new HttpError(408, "Sandbox service request deadline exceeded.");
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > maxBytes) throw new HttpError(413, "Sandbox service request is too large.");
      chunks.push(bytes);
    }
  } catch (cause) {
    if (signal.aborted) throw new HttpError(408, "Sandbox service request deadline exceeded.");
    throw cause;
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("not an object");
    return value as JsonBody;
  } catch {
    throw new HttpError(400, "Sandbox service request must be valid JSON.");
  }
}

async function authorized(
  header: string | undefined,
  secret: string,
  scope: SandboxServiceScope,
): Promise<SandboxScopeClaims | undefined> {
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return undefined;
  const [version, encodedPayload, encodedSignature] = parts;
  void version;
  const payload = decodeBase64Url(encodedPayload!);
  if (!payload) return undefined;
  const expected = createHmac("sha256", secret).update(encodedPayload!).digest("base64url");
  const actual = encodedSignature!;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  if (
    expectedBytes.byteLength !== actualBytes.byteLength ||
    !timingSafeEqual(expectedBytes, actualBytes)
  )
    return undefined;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown> & { v?: unknown };
    if (
      parsed.v !== 1 ||
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.providerId !== "string" ||
      typeof parsed.instanceId !== "string" ||
      (parsed.userId !== undefined && typeof parsed.userId !== "string") ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= Math.floor(Date.now() / 1000) ||
      parsed.expiresAt > Math.floor(Date.now() / 1000) + 300
    )
      return undefined;
    if (
      parsed.workspaceId !== scope.workspaceId ||
      parsed.providerId !== scope.providerId ||
      parsed.instanceId !== scope.instanceId ||
      (parsed.userId ?? undefined) !== scope.userId
    )
      return undefined;
    return {
      workspaceId: parsed.workspaceId,
      providerId: parsed.providerId,
      instanceId: parsed.instanceId,
      ...(scope.userId ? { userId: scope.userId } : {}),
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      const reason = signal.reason;
      const error =
        reason instanceof Error ? reason : new Error("Sandbox service operation aborted.");
      error.name = "AbortError";
      finish(() => reject(error));
    };
    const pending = signal.aborted
      ? Promise.reject<T>(new Error("Sandbox service operation aborted."))
      : Promise.resolve().then(operation);
    pending.then(
      (value) => finish(() => resolve(value)),
      (cause) => finish(() => reject(cause)),
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  if (status === 204) {
    response.end();
    return;
  }
  const body = JSON.stringify(value);
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

function safeMessage(cause: unknown): string {
  if (cause instanceof HttpError) return cause.message;
  return "Sandbox service operation failed.";
}

function isUnknownOutcome(cause: unknown): boolean {
  return (
    cause instanceof DockerUnknownOutcomeError ||
    (typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "unknown_outcome")
  );
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength)
    throw new HttpError(400, `${field} must be a non-empty string.`);
  return value;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string, maxBytes: number): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new HttpError(400, "bytesBase64 is invalid.");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes > maxBytes)
    throw new HttpError(413, "Sandbox file exceeds the service size limit.");
  return new Uint8Array(Buffer.from(value, "base64"));
}
