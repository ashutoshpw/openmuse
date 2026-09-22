import type { JsonObject, ProviderModule } from "@openmuse/contracts";

export type ProviderErrorCode =
  | "invalid_request"
  | "authentication_required"
  | "permission_denied"
  | "scope_missing"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "failed"
  | "unknown_outcome";

export interface NormalizedProviderErrorShape {
  code: ProviderErrorCode;
  message: string;
  safeMessage: string;
  retryable: boolean;
  uncertain: boolean;
  providerId?: string;
  module?: ProviderModule;
  operation?: string;
  providerCode?: string;
  retryAfterSeconds?: number;
  details?: JsonObject;
}

export class ProviderOperationError extends Error implements NormalizedProviderErrorShape {
  readonly code: ProviderErrorCode;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly uncertain: boolean;
  readonly providerId?: string;
  readonly module?: ProviderModule;
  readonly operation?: string;
  readonly providerCode?: string;
  readonly retryAfterSeconds?: number;
  readonly details?: JsonObject;

  constructor(shape: NormalizedProviderErrorShape, options?: ErrorOptions) {
    super(shape.message, options);
    this.name = "ProviderOperationError";
    this.code = shape.code;
    this.safeMessage = shape.safeMessage;
    this.retryable = shape.retryable;
    this.uncertain = shape.uncertain;
    if (shape.providerId !== undefined) this.providerId = shape.providerId;
    if (shape.module !== undefined) this.module = shape.module;
    if (shape.operation !== undefined) this.operation = shape.operation;
    if (shape.providerCode !== undefined) this.providerCode = shape.providerCode;
    if (shape.retryAfterSeconds !== undefined) this.retryAfterSeconds = shape.retryAfterSeconds;
    if (shape.details !== undefined) this.details = shape.details;
  }
}

const secretLikeKey = /(token|secret|password|authorization|cookie|api[-_]?key|private[-_]?key)/i;

export function redactProviderDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProviderDetails);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        secretLikeKey.test(key) ? "[REDACTED]" : redactProviderDetails(child),
      ]),
    );
  }
  if (typeof value === "string" && value.length > 2048) return `${value.slice(0, 2048)}…`;
  return value;
}

export function normalizeProviderError(
  error: unknown,
  context: Pick<NormalizedProviderErrorShape, "providerId" | "module" | "operation"> &
    Partial<Pick<NormalizedProviderErrorShape, "uncertain">>,
): ProviderOperationError {
  if (error instanceof ProviderOperationError) return error;
  const message = error instanceof Error ? error.message : "Provider operation failed";
  const unknownOutcome = context.uncertain === true;
  const shape: NormalizedProviderErrorShape = {
    code: unknownOutcome ? "unknown_outcome" : "failed",
    message,
    safeMessage: "The provider operation could not be completed.",
    retryable: !unknownOutcome,
    uncertain: unknownOutcome,
    details: { cause: redactProviderDetails(message) as string },
  };
  if (context.providerId !== undefined) shape.providerId = context.providerId;
  if (context.module !== undefined) shape.module = context.module;
  if (context.operation !== undefined) shape.operation = context.operation;
  return new ProviderOperationError(shape);
}
