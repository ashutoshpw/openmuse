import { z } from "zod";

export const idSchema = z.string().trim().min(1).max(256);
export const digestSchema = z.string().regex(/^[a-zA-Z0-9:_-]{8,256}$/);
export const cursorSchema = z.string().max(2048).optional();

/** ISO-8601 values are kept as strings at the transport boundary. */
export const timestampSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  "Expected an ISO-8601 timestamp",
);

export const nonEmptyTextSchema = z.string().trim().min(1);
export const safeNameSchema = z.string().trim().min(1).max(256);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export const paginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: cursorSchema,
});

export const pageInfoSchema = z.object({
  nextCursor: z.string().max(2048).nullable(),
  hasMore: z.boolean(),
});

export type PaginationInput = z.input<typeof paginationSchema>;
export type Page<T> = { items: T[]; page: z.infer<typeof pageInfoSchema> };

export const resourceScopeSchema = z.object({
  userId: idSchema,
  workspaceId: idSchema,
});

export const roleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export const visibilitySchema = z.enum(["private", "workspace"]);

export const errorCodeSchema = z.enum([
  "invalid_request",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "provider_unavailable",
  "provider_auth_required",
  "provider_scope_missing",
  "provider_invalid_request",
  "provider_failed",
  "provider_unknown_outcome",
  "cancelled",
  "expired",
  "internal",
]);

export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: nonEmptyTextSchema.max(500),
  requestId: idSchema.optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  details: jsonObjectSchema.optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "blocked_reconnect",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);

export const eventTypeSchema = z.enum([
  "run.created",
  "run.started",
  "run.progress",
  "run.waiting_approval",
  "run.blocked_reconnect",
  "message.created",
  "message.delta",
  "message.completed",
  "tool.call",
  "tool.result",
  "artifact.created",
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export const providerModuleSchema = z.enum([
  "model",
  "image",
  "stt",
  "tts",
  "realtime",
  "search",
  "sandbox",
  "browser",
  "storage",
  "connector",
  "notification",
]);

export const providerStatusSchema = z.enum(["available", "unavailable", "disabled"]);

export const connectionStatusSchema = z.enum([
  "active",
  "reauthorization_required",
  "revoked",
  "expired",
  "disconnected",
]);

export const memoryScopeSchema = z.enum(["user", "workspace", "conversation"]);

export type Id = z.infer<typeof idSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;
export type ProviderModule = z.infer<typeof providerModuleSchema>;
