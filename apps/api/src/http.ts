import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { OpenMuseAuth, RequestIdentity } from "@openmuse/auth";
import { AuthError } from "@openmuse/auth";
import { ApplicationError } from "@openmuse/application";
import type { DatabaseClient } from "@openmuse/db";
import { resolveResourceWorkspace } from "@openmuse/db";

export type ApiEnv = {
  Variables: {
    identity: RequestIdentity;
    requestId: string;
  };
};

export type ApiContext = Context<ApiEnv>;

export interface ApiRouteOptions {
  db: DatabaseClient;
  auth: OpenMuseAuth;
}

const secretKey = /(token|secret|password|authorization|cookie|api[-_]?key|private[-_]?key)/i;

function redactForLog(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...(value.cause === undefined ? {} : { cause: redactForLog(value.cause) }),
    };
  }
  if (Array.isArray(value)) return value.map(redactForLog);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        secretKey.test(key) ? "[REDACTED]" : redactForLog(child),
      ]),
    );
  }
  return typeof value === "string" ? redactText(value) : value;
}

function redactText(value: string): string {
  return value
    .replace(/bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|password|api[-_]?key)=([^\s&]+)/gi, "$1=[REDACTED]")
    .slice(0, 2048);
}

export function jsonError(c: ApiContext, error: unknown, requestId: string) {
  if (error instanceof AuthError) {
    return c.json(
      { error: { code: error.code, message: error.message, requestId } },
      error.status as 401 | 400 | 403 | 404,
    );
  }
  if (error instanceof ApplicationError) {
    return c.json(
      { error: { code: error.code, message: error.message, requestId } },
      error.status as 400 | 403 | 404 | 409 | 500,
    );
  }
  console.error("openmuse_api_error", { requestId, error: redactForLog(error) });
  return c.json(
    { error: { code: "internal", message: "The request could not be completed.", requestId } },
    500,
  );
}

export function envelope<T>(c: ApiContext, data: T, requestId: string) {
  return c.json({ data, requestId });
}

export function parseJson(c: ApiContext): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

export async function resolveWorkspace(
  options: ApiRouteOptions,
  resourceType: Parameters<typeof resolveResourceWorkspace>[1],
  resourceId: string,
  actorId: string,
): Promise<string | undefined> {
  return resolveResourceWorkspace(options.db.db, resourceType, resourceId, actorId);
}

export function requestId(c: ApiContext): string {
  return c.get("requestId") || randomUUID();
}

export type ApiApp = Hono<ApiEnv>;
