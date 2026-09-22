import type { JsonObject, JsonValue } from "@openmuse/contracts";
import type { ProviderModule } from "@openmuse/provider-contracts";

export class CoreError extends Error {
  readonly code: string;
  readonly safeMessage: string;
  readonly details?: JsonObject;

  constructor(code: string, safeMessage: string, details?: JsonObject, options?: ErrorOptions) {
    super(safeMessage, options);
    this.name = "CoreError";
    this.code = code;
    this.safeMessage = safeMessage;
    if (details !== undefined) this.details = details;
  }
}

const secretKey = /(token|secret|password|authorization|cookie|api[-_]?key|private[-_]?key)/i;

export function redact(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "string" && value.length > 2048) return `${value.slice(0, 2048)}…`;
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        secretKey.test(key) ? "[REDACTED]" : redact(child),
      ]),
    );
  }
  return "[UNSERIALIZABLE]";
}

export function providerUnavailableError(module: ProviderModule, providerId: string): CoreError {
  return new CoreError("provider_unavailable", "The selected provider is unavailable.", {
    module,
    providerId,
  });
}
