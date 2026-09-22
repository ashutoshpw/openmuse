import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DockerContainer,
  DockerContainerSpec,
  DockerExecRequest,
  DockerRuntime,
} from "@openmuse/provider-sandbox-docker";
import type { SandboxFile } from "@openmuse/provider-contracts";

export interface SandboxServiceOptions {
  runtime: DockerRuntime;
  serviceToken: string;
  maxBodyBytes?: number;
}

interface JsonBody {
  [key: string]: unknown;
}

export function createSandboxService(options: SandboxServiceOptions) {
  if (!options.serviceToken.trim()) throw new Error("SANDBOX_SERVICE_TOKEN is required.");
  const maxBodyBytes = options.maxBodyBytes ?? 12 * 1024 * 1024;

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (!authorized(request.headers.authorization, options.serviceToken)) {
      json(response, 401, { error: "Sandbox service authentication required." });
      return;
    }
    const url = new URL(request.url ?? "/", "http://sandbox-service.local");
    const route = url.pathname.split("/").filter(Boolean);
    try {
      if (
        request.method === "GET" &&
        route.length === 3 &&
        route[0] === "v1" &&
        route[1] === "sandboxes"
      ) {
        const container = await ownedContainer(
          route[2]!,
          workspaceHeader(request),
          request,
          options.runtime,
        );
        json(response, 200, await container.inspect());
        return;
      }
      if (
        route.length === 2 &&
        route[0] === "v1" &&
        route[1] === "sandboxes" &&
        request.method === "POST"
      ) {
        const body = await readJson(request, maxBodyBytes);
        const spec = parseSpec(body);
        const workspaceId = spec.labels["openmuse.workspace_id"];
        const requestedWorkspace = workspaceHeader(request);
        if (requestedWorkspace && requestedWorkspace !== workspaceId)
          throw new HttpError(403, "Workspace binding mismatch.");
        const container = await options.runtime.create(spec, requestSignal(request));
        json(response, 201, { id: container.id });
        return;
      }
      if (route.length >= 4 && route[0] === "v1" && route[1] === "sandboxes") {
        const id = route[2]!;
        const container = await ownedContainer(
          id,
          workspaceHeader(request),
          request,
          options.runtime,
        );
        if (route[3] === "exec" && request.method === "POST") {
          const body = await readJson(request, maxBodyBytes);
          const operationId = requiredString(body.operationId, "operationId");
          const exec = parseExec(body, operationId, requestSignal(request));
          const result = await container.exec(exec);
          json(response, 200, result);
          return;
        }
        if (route[3] === "files" && route[4] === "read" && request.method === "POST") {
          const body = await readJson(request, maxBodyBytes);
          const bytes = await container.readFile(
            requiredString(body.path, "path"),
            requestSignal(request),
          );
          json(response, 200, { bytesBase64: toBase64(bytes) });
          return;
        }
        if (route[3] === "files" && route[4] === "write" && request.method === "POST") {
          const body = await readJson(request, maxBodyBytes);
          const file: SandboxFile = {
            path: requiredString(body.path, "path"),
            bytes: fromBase64(requiredString(body.bytesBase64, "bytesBase64")),
            ...(typeof body.contentType === "string" ? { contentType: body.contentType } : {}),
          };
          await container.writeFile(file, requestSignal(request));
          json(response, 204, undefined);
          return;
        }
        if (route[3] === "operations" && route[5] === "cancel" && request.method === "POST") {
          await container.cancel?.(route[4]!);
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
        const container = await ownedContainer(
          route[2]!,
          workspaceHeader(request),
          request,
          options.runtime,
        );
        await container.destroy("service delete");
        json(response, 204, undefined);
        return;
      }
      throw new HttpError(404, "Sandbox service route not found.");
    } catch (cause) {
      const status = cause instanceof HttpError ? cause.status : 500;
      json(response, status, { error: safeMessage(cause) });
    }
  };
}

async function ownedContainer(
  id: string,
  workspaceId: string | undefined,
  request: IncomingMessage,
  runtime: DockerRuntime,
): Promise<DockerContainer> {
  const container = await runtime.get(id, requestSignal(request));
  const inspection = await container.inspect();
  const owner = inspection.labels["openmuse.workspace_id"];
  if (!owner || (workspaceId && owner !== workspaceId))
    throw new HttpError(403, "Sandbox workspace binding mismatch.");
  if (inspection.labels["openmuse.provider"] !== "sandbox-docker")
    throw new HttpError(403, "Sandbox provider binding mismatch.");
  return container;
}

function parseSpec(body: JsonBody): DockerContainerSpec {
  if (
    typeof body.image !== "string" ||
    !/^.+@sha256:[0-9a-f]{64}$/i.test(body.image) ||
    body.networkDisabled !== true ||
    body.privileged !== false ||
    !Array.isArray(body.mounts) ||
    body.mounts.length !== 0
  )
    throw new HttpError(
      400,
      "Only digest-pinned, network-disabled, mount-free sandboxes are supported.",
    );
  const labels = parseStringMap(body.labels, "labels");
  if (!labels["openmuse.workspace_id"] || labels["openmuse.provider"] !== "sandbox-docker")
    throw new HttpError(400, "Sandbox ownership labels are required.");
  if (!body.limits || typeof body.limits !== "object" || Array.isArray(body.limits))
    throw new HttpError(400, "Sandbox limits are required.");
  return {
    image: body.image,
    labels,
    limits: body.limits as DockerContainerSpec["limits"],
    networkDisabled: true,
    privileged: false,
    mounts: [],
  };
}

function parseExec(body: JsonBody, operationId: string, signal: AbortSignal): DockerExecRequest {
  if (
    !Array.isArray(body.argv) ||
    body.argv.length === 0 ||
    body.argv.some((value) => typeof value !== "string")
  )
    throw new HttpError(400, "Sandbox argv must be a non-empty string array.");
  return {
    argv: body.argv,
    ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
    ...(body.env && typeof body.env === "object" && !Array.isArray(body.env)
      ? { env: parseStringMap(body.env, "env") }
      : {}),
    ...(typeof body.timeoutSeconds === "number" ? { timeoutSeconds: body.timeoutSeconds } : {}),
    operationId,
    signal,
  };
}

function parseStringMap(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, `${field} must be an object.`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string" || key.length > 128 || item.length > 64 * 1024)
      throw new HttpError(400, `${field} contains an invalid value.`);
    result[key] = item;
  }
  return result;
}

function workspaceHeader(request: IncomingMessage): string | undefined {
  const value = request.headers["x-openmuse-workspace"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requestSignal(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort("client disconnected");
  request.once("aborted", abort);
  request.socket.once("close", abort);
  return controller.signal;
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new HttpError(413, "Sandbox service request is too large.");
    chunks.push(bytes);
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

function authorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const target = Buffer.from(expected);
  return actual.byteLength === target.byteLength && timingSafeEqual(actual, target);
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
  if (cause instanceof Error) return cause.message.slice(0, 500);
  return "Sandbox service operation failed.";
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256)
    throw new HttpError(400, `${field} must be a non-empty string.`);
  return value;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new HttpError(400, "bytesBase64 is invalid.");
  return new Uint8Array(Buffer.from(value, "base64"));
}
