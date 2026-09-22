import { z } from "zod";
import type { JsonObject, JsonValue, ProviderModule } from "@openmuse/contracts";

export type { ProviderModule };

export interface ProviderLogger {
  debug(message: string, fields?: Record<string, JsonValue>): void;
  info(message: string, fields?: Record<string, JsonValue>): void;
  warn(message: string, fields?: Record<string, JsonValue>): void;
  error(message: string, fields?: Record<string, JsonValue>): void;
}

export interface ProviderSecretResolver {
  resolve(reference: string, signal?: AbortSignal): Promise<string>;
}

export interface ProviderCreateContext {
  signal: AbortSignal;
  scopeId: string;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  runId?: string;
  operationId?: string;
  idempotencyKey?: string;
  secrets?: ProviderSecretResolver;
  logger?: ProviderLogger;
}

export interface ProviderConfigDefinition<Config> {
  version: string;
  schema: z.ZodType<Config>;
  defaults?: () => Partial<Config>;
  secretReferences?: (config: Config) => readonly string[];
  redact?: (config: Config) => JsonObject;
}

export interface ProviderCapability {
  key: string;
  description?: string;
  inputSchemaVersion?: string;
  outputSchemaVersion?: string;
}

export interface ProviderSecretMetadata {
  name: string;
  description?: string;
  required: boolean;
}

export interface ProviderMetadata {
  providerId: string;
  displayName: string;
  version: string;
  configVersion: string;
  buildDigest: string;
  capabilities: readonly ProviderCapability[];
  requiredSecrets: readonly ProviderSecretMetadata[];
  trusted: boolean;
}

export interface AsyncDisposable {
  close(reason?: string): Promise<void>;
}

export interface ProviderRegistration<Config, Instance> {
  readonly module: ProviderModule;
  readonly providerId: string;
  readonly metadata: ProviderMetadata;
  readonly config: ProviderConfigDefinition<Config>;
  create(config: Config, context: ProviderCreateContext): Promise<Instance>;
}

export interface ProviderOperationContext {
  signal: AbortSignal;
  operationId: string;
  idempotencyKey?: string;
  /** The tenant and workspace are repeated on operation contexts so providers
   * can enforce ownership on reconnects and long-lived resources. */
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
}

export interface ProviderBlob {
  bytes: Uint8Array;
  contentType: string;
  fileName?: string;
}

export interface ProviderReference {
  id: string;
  contentType?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface ProviderJsonResult {
  data: JsonValue;
  providerOperationId?: string;
}

export type { JsonObject, JsonValue };
