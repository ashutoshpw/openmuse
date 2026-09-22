import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ProviderRegistry, type ProviderScope } from "@openmuse/core";
import { ScopedDatabase, providerCredentials, runs, type OpenMuseDatabase } from "@openmuse/db";
import { and, eq, isNull, or } from "drizzle-orm";
import type {
  ModelClient,
  ModelConfig,
  ModelDriver,
  ModelEvent,
  ModelGenerateRequest,
  ProviderConfigDefinition,
  ProviderCreateContext,
  ProviderModule,
  ProviderOperationContext,
  ProviderSecretResolver,
} from "@openmuse/provider-contracts";
import { createAppConnectConnectorDriver } from "@openmuse/provider-connector-appconnect";
import { createMetaModelDriver } from "@openmuse/provider-model-meta";
import { createOllamaModelDriver } from "@openmuse/provider-model-ollama";
import { createOpenAiCompatibleModelDriver } from "@openmuse/provider-model-openai-compatible";
import { createExaSearchDriver } from "@openmuse/provider-search-exa";
import { createTavilySearchDriver } from "@openmuse/provider-search-tavily";
import { createDaytonaSandboxDriver } from "@openmuse/provider-sandbox-daytona";
import { createE2BSandboxDriver } from "@openmuse/provider-sandbox-e2b";
import { createS3StorageDriver } from "@openmuse/provider-storage-s3";
import type { ConversationTaskPayload, ResolvedModel } from "@openmuse/application";
import type { TaskExecutionContext } from "@openmuse/application";
import type { Task as DbTask } from "@openmuse/db";

export interface ProviderEndpointPolicy {
  /** Exact origin/path prefixes trusted by the deployment operator. */
  trustedEndpoints?: readonly string[];
}

export interface ProviderCatalogEntry {
  module: ProviderModule;
  providerId: string;
  displayName: string;
  version: string;
  configVersion: string;
  buildDigest: string;
  capabilities: readonly { key: string; description?: string }[];
  requiredSecrets: readonly { name: string; description?: string; required: boolean }[];
  trusted: boolean;
}

/**
 * The API uses this catalogue to validate metadata/configuration only. It
 * cannot construct a provider client, and arbitrary user endpoints are
 * rejected unless the deployment operator explicitly allowlists them.
 */
export class ProviderCatalog {
  constructor(
    readonly registry: ProviderRegistry,
    private readonly endpointPolicy: ProviderEndpointPolicy = {},
  ) {}

  list(module?: ProviderModule): ProviderCatalogEntry[] {
    return this.registry.list(module).map((view) => ({
      module: view.module,
      providerId: view.providerId,
      displayName: view.metadata.displayName,
      version: view.metadata.version,
      configVersion: view.configVersion,
      buildDigest: view.metadata.buildDigest,
      capabilities: view.metadata.capabilities.map(({ key, description }) => ({
        key,
        ...(description === undefined ? {} : { description }),
      })),
      requiredSecrets: view.metadata.requiredSecrets.map(({ name, description, required }) => ({
        name,
        ...(description === undefined ? {} : { description }),
        required,
      })),
      trusted: view.metadata.trusted,
    }));
  }

  get(module: ProviderModule, providerId: string): ProviderCatalogEntry {
    const view = this.registry.get(module, providerId);
    return {
      module: view.module,
      providerId: view.providerId,
      displayName: view.metadata.displayName,
      version: view.metadata.version,
      configVersion: view.configVersion,
      buildDigest: view.metadata.buildDigest,
      capabilities: view.metadata.capabilities.map(({ key, description }) => ({
        key,
        ...(description === undefined ? {} : { description }),
      })),
      requiredSecrets: view.metadata.requiredSecrets.map(({ name, description, required }) => ({
        name,
        ...(description === undefined ? {} : { description }),
        required,
      })),
      trusted: view.metadata.trusted,
    };
  }

  normalizeConfig(
    module: ProviderModule,
    providerId: string,
    rawConfig: unknown,
  ): Record<string, unknown> {
    const parsed = this.registry.normalizeConfig(module, providerId, rawConfig);
    if (!isObject(parsed)) throw new Error("Provider configuration must be a JSON object");
    assertTrustedEndpoint(parsed.endpoint, providerId, this.endpointPolicy);
    return parsed;
  }

  digest(input: {
    module: ProviderModule;
    providerId: string;
    version: string;
    configVersion: string;
    buildDigest: string;
    config: Record<string, unknown>;
    credentialBindings: readonly { name: string; credentialId: string; revision: number }[];
  }): string {
    return createHash("sha256")
      .update(
        canonicalize({
          module: input.module,
          providerId: input.providerId,
          version: input.version,
          configVersion: input.configVersion,
          buildDigest: input.buildDigest,
          config: input.config,
          credentialBindings: input.credentialBindings,
        }),
      )
      .digest("hex");
  }
}

const BUILTIN_ENDPOINTS: Record<string, string> = {
  "openai-compatible": "https://api.openai.com/v1",
  "meta-llama": "https://api.llama.com/compat/v1",
};

function assertTrustedEndpoint(
  endpoint: unknown,
  providerId: string,
  policy: ProviderEndpointPolicy,
): void {
  if (endpoint === undefined) return;
  if (typeof endpoint !== "string") throw new Error("Provider endpoint must be a URL");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Provider endpoint must be a valid URL");
  }
  if (parsed.username || parsed.password)
    throw new Error("Provider endpoints may not contain embedded credentials");
  const candidate = parsed.toString().replace(/\/$/, "");
  const trusted = new Set([
    ...(BUILTIN_ENDPOINTS[providerId] ? [BUILTIN_ENDPOINTS[providerId]] : []),
    ...(policy.trustedEndpoints ?? []),
  ]);
  if (![...trusted].some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`)))
    throw new Error("This provider endpoint is not trusted by the deployment operator");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value as object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

export interface CredentialAad {
  workspaceId: string;
  actorId: string;
  providerInstanceId: string;
  secretName: string;
  revision: number;
}

/**
 * The credential envelope currently has one supported key version. Key
 * rotation must re-encrypt every credential under the replacement key before
 * changing the deployment secret; a future envelope version requires a key
 * ring and an explicit migration rather than silently trying the active key.
 */
export const SUPPORTED_CREDENTIAL_KEY_VERSION = 1;

function aadString(aad: CredentialAad): string {
  return canonicalize({
    version: "v1",
    workspaceId: aad.workspaceId,
    actorId: aad.actorId,
    providerInstanceId: aad.providerInstanceId,
    secretName: aad.secretName,
    revision: aad.revision,
  });
}

export function encodeCredentialKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

/** Encrypt while retaining the generated IV in an explicit envelope. */
export function encryptCredentialEnvelope(
  value: string,
  encodedKey: string,
  aad: CredentialAad,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encodeCredentialKey(encodedKey), iv);
  cipher.setAAD(Buffer.from(aadString(aad), "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    `v${SUPPORTED_CREDENTIAL_KEY_VERSION}`,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptCredentialEnvelope(
  envelope: string,
  encodedKey: string,
  aad: CredentialAad,
): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== `v${SUPPORTED_CREDENTIAL_KEY_VERSION}`)
    throw new Error("The provider credential has an unsupported encryption format");
  const iv = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const tag = Buffer.from(parts[2]!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const ciphertext = Buffer.from(parts[3]!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error("The provider credential encryption envelope is invalid");
  const decipher = createDecipheriv("aes-256-gcm", encodeCredentialKey(encodedKey), iv);
  decipher.setAAD(Buffer.from(aadString(aad), "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export interface BuiltinProviderRegistryOptions {
  deterministic?: boolean;
  deterministicResponse?: string;
  endpointPolicy?: ProviderEndpointPolicy;
}

export function createBuiltinProviderRegistry(
  options: BuiltinProviderRegistryOptions = {},
): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(createDaytonaSandboxDriver());
  registry.register(createE2BSandboxDriver());
  registry.register(createOpenAiCompatibleModelDriver());
  registry.register(createMetaModelDriver());
  registry.register(createOllamaModelDriver());
  registry.register(createTavilySearchDriver());
  registry.register(createExaSearchDriver());
  registry.register(createAppConnectConnectorDriver());
  const trustedEndpoints = options.endpointPolicy?.trustedEndpoints;
  registry.register(
    createS3StorageDriver(trustedEndpoints === undefined ? {} : { trustedEndpoints }),
  );
  if (options.deterministic)
    registry.register(createDeterministicModelDriver(options.deterministicResponse));
  return registry;
}

export function createBuiltinProviderCatalog(
  options: ProviderEndpointPolicy = {},
): ProviderCatalog {
  return new ProviderCatalog(createBuiltinProviderRegistry({ endpointPolicy: options }), options);
}

function createDeterministicModelDriver(response = "deterministic response"): ModelDriver {
  const schema: ProviderConfigDefinition<ModelConfig> = {
    version: "1",
    schema: {
      parse: () => ({}),
      safeParse: () => ({ success: true, data: {} }),
    } as unknown as ProviderConfigDefinition<ModelConfig>["schema"],
  };
  return {
    module: "model",
    providerId: "deterministic",
    metadata: {
      providerId: "deterministic",
      displayName: "Deterministic test model",
      version: "1",
      configVersion: "1",
      buildDigest: "builtin:deterministic:1",
      capabilities: [{ key: "generate" }],
      requiredSecrets: [],
      trusted: true,
    },
    config: schema,
    async create(_config: ModelConfig, _context: ProviderCreateContext): Promise<ModelClient> {
      return {
        async *generate(
          _request: ModelGenerateRequest,
          operation: ProviderOperationContext,
        ): AsyncIterable<ModelEvent> {
          if (operation.signal.aborted) throw operation.signal.reason ?? new Error("Aborted");
          yield { type: "text_delta", text: response };
          yield { type: "usage", inputTokens: 1, outputTokens: response.length };
          yield { type: "completed", finishReason: "stop" };
        },
        async close() {},
      };
    },
  };
}

export interface ProviderRuntimeOptions {
  db: OpenMuseDatabase;
  encryptionKey?: string;
  deterministic?: boolean;
  deterministicResponse?: string;
  endpointPolicy?: ProviderEndpointPolicy;
  /** Test and embedded runtimes may supply an explicitly registered provider set. */
  registry?: ProviderRegistry;
}

interface SelectedProviderInstance {
  id: string;
  providerId: string;
  module: string;
  config: Record<string, unknown>;
  credentialBindings: Array<{ name: string; credentialId: string; revision: number }>;
  configDigest: string;
}

/** Worker-only provider composition and exact pinned-run resolution. */
export class WorkerProviderRuntime {
  private readonly registry: ProviderRegistry;
  private readonly catalog: ProviderCatalog;

  constructor(private readonly options: ProviderRuntimeOptions) {
    if (options.deterministic && process.env.NODE_ENV !== "test")
      throw new Error("Deterministic provider mode is test-only");
    this.registry =
      options.registry ??
      createBuiltinProviderRegistry({
        ...(options.endpointPolicy === undefined ? {} : { endpointPolicy: options.endpointPolicy }),
        ...(options.deterministic === undefined ? {} : { deterministic: options.deterministic }),
        ...(options.deterministicResponse === undefined
          ? {}
          : { deterministicResponse: options.deterministicResponse }),
      });
    this.catalog = new ProviderCatalog(this.registry, options.endpointPolicy);
  }

  async resolveModel(
    payload: ConversationTaskPayload,
    context: TaskExecutionContext,
    task: DbTask,
  ): Promise<ResolvedModel> {
    const selected = await this.selectPinnedModel(payload, task);
    if (!selected) {
      if (this.options.deterministic) return this.resolveDeterministic(context, task);
      throw new Error("No pinned model provider is configured for this run");
    }
    if (selected.module !== "model") throw new Error("The pinned provider is not a model");
    const scoped = new ScopedDatabase(this.options.db, {
      workspaceId: task.workspaceId,
      actorId: task.requestedBy,
    });
    const config = applyCredentialBindings(selected.config, selected.credentialBindings);
    const secrets = new DatabaseSecretResolver(
      scoped,
      selected.providerId,
      selected.id,
      selected.credentialBindings,
      this.options.encryptionKey,
    );
    const scope = this.registry.createScope({
      scopeId: `task:${task.id}`,
      tenantId: task.workspaceId,
      workspaceId: task.workspaceId,
      userId: task.requestedBy,
      runId: payload.runId,
      signal: context.signal,
      secrets,
    });
    try {
      const client = await scope.resolve<ModelClient>(
        selected.id,
        "model",
        selected.providerId,
        config,
        { configDigest: selected.configDigest },
      );
      return {
        client: scopedModelClient(client, scope),
        providerInstanceId: selected.id,
        providerId: selected.providerId,
        configDigest: selected.configDigest,
        ...(payload.model ? { model: payload.model } : {}),
      };
    } catch (error) {
      await scope.close("provider construction failed").catch(() => undefined);
      throw error;
    }
  }

  private async selectPinnedModel(
    payload: ConversationTaskPayload,
    task: DbTask,
  ): Promise<SelectedProviderInstance | undefined> {
    const scoped = new ScopedDatabase(this.options.db, {
      workspaceId: task.workspaceId,
      actorId: task.requestedBy,
    });
    return scoped.run(async (tx) => {
      const [run] = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.id, payload.runId),
            eq(runs.workspaceId, task.workspaceId),
            eq(runs.requestedBy, task.requestedBy),
          ),
        )
        .limit(1);
      if (!run?.providerInstanceId || !run.providerId || !run.providerModule || !run.providerConfig)
        return undefined;
      if (run.providerInstanceId !== payload.providerInstanceId && payload.providerInstanceId)
        throw new Error("The task provider does not match the pinned run");
      const rawBindings = run.providerCredentialBindings;
      const bindings = Array.isArray(rawBindings) ? rawBindings.filter(isPinnedBinding) : [];
      if (!Array.isArray(rawBindings) || bindings.length !== rawBindings.length)
        throw new Error("The pinned provider credential bindings are incomplete");
      if (
        !run.configDigest ||
        !run.providerBuildDigest ||
        !run.providerVersion ||
        !run.providerConfigVersion
      )
        throw new Error("The run provider snapshot is incomplete");
      const catalogEntry = this.catalog.get(run.providerModule as ProviderModule, run.providerId);
      if (
        catalogEntry.buildDigest !== run.providerBuildDigest ||
        catalogEntry.version !== run.providerVersion ||
        catalogEntry.configVersion !== run.providerConfigVersion
      )
        throw new Error("The pinned provider build is unavailable");
      assertPinnedProviderCredentials(
        catalogEntry,
        run.providerConfig as Record<string, unknown>,
        bindings,
      );
      const expectedDigest = this.catalog.digest({
        module: run.providerModule as ProviderModule,
        providerId: run.providerId,
        version: run.providerVersion,
        configVersion: run.providerConfigVersion,
        buildDigest: run.providerBuildDigest,
        config: run.providerConfig as Record<string, unknown>,
        credentialBindings: bindings,
      });
      if (expectedDigest !== run.configDigest)
        throw new Error("The pinned provider digest is invalid");
      // Re-validate the stored endpoint at execution time. API-time catalog
      // validation is not sufficient for legacy rows or direct DB writes, and
      // loopback/private Ollama endpoints require an operator allowlist in
      // both the API and worker environments.
      this.catalog.normalizeConfig(
        run.providerModule as ProviderModule,
        run.providerId,
        run.providerConfig,
      );
      return {
        id: run.providerInstanceId,
        providerId: run.providerId,
        module: run.providerModule,
        config: run.providerConfig as Record<string, unknown>,
        credentialBindings: bindings,
        configDigest: run.configDigest,
      };
    });
  }

  private async resolveDeterministic(
    context: TaskExecutionContext,
    task: DbTask,
  ): Promise<ResolvedModel> {
    const scope = this.registry.createScope({
      scopeId: `task:${task.id}`,
      tenantId: task.workspaceId,
      workspaceId: task.workspaceId,
      userId: task.requestedBy,
      ...(task.runId ? { runId: task.runId } : {}),
      signal: context.signal,
    });
    try {
      const client = await scope.resolve<ModelClient>(
        `deterministic:${task.workspaceId}`,
        "model",
        "deterministic",
        {},
        { configDigest: "builtin:deterministic:1" },
      );
      return {
        client: scopedModelClient(client, scope),
        providerInstanceId: `deterministic:${task.workspaceId}`,
        providerId: "deterministic",
        configDigest: "builtin:deterministic:1",
      };
    } catch (error) {
      await scope.close("deterministic provider construction failed").catch(() => undefined);
      throw error;
    }
  }
}

function isPinnedBinding(
  value: unknown,
): value is { name: string; credentialId: string; revision: number } {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    typeof value.credentialId === "string" &&
    typeof value.revision === "number" &&
    Number.isInteger(value.revision) &&
    value.revision > 0
  );
}

function assertPinnedProviderCredentials(
  provider: ProviderCatalogEntry,
  config: Record<string, unknown>,
  bindings: readonly { name: string; credentialId: string; revision: number }[],
): void {
  const declaredNames = new Set(provider.requiredSecrets.map((secret) => secret.name));
  const byName = new Map<string, (typeof bindings)[number]>();
  for (const binding of bindings) {
    if (
      !declaredNames.has(binding.name) ||
      binding.credentialId.startsWith("pending:") ||
      byName.has(binding.name)
    )
      throw new Error("The pinned provider credential bindings are invalid");
    byName.set(binding.name, binding);
  }
  for (const secret of provider.requiredSecrets) {
    const binding = byName.get(secret.name);
    const configured = config[secret.name];
    if (
      secret.required &&
      (!binding || configured !== binding.credentialId || String(configured).startsWith("pending:"))
    )
      throw new Error("The pinned provider credentials are incomplete");
    if (configured !== undefined && (!binding || configured !== binding.credentialId))
      throw new Error("The pinned provider credential reference is invalid");
  }
}

function applyCredentialBindings(
  config: Record<string, unknown>,
  bindings: readonly { name: string; credentialId: string; revision: number }[],
): Record<string, unknown> {
  const next = { ...config };
  for (const binding of bindings) {
    if (
      !binding.name.trim() ||
      !binding.credentialId.trim() ||
      binding.credentialId.startsWith("pending:")
    )
      throw new Error("A provider credential binding is invalid");
    next[binding.name] = binding.credentialId;
  }
  return next;
}

function scopedModelClient(client: ModelClient, scope: ProviderScope): ModelClient {
  return {
    generate: (request, context) => client.generate(request, context),
    ...(client.listModels
      ? { listModels: (context: ProviderOperationContext) => client.listModels!(context) }
      : {}),
    close: (reason?: string) => scope.close(reason),
  };
}

class DatabaseSecretResolver implements ProviderSecretResolver {
  constructor(
    private readonly scoped: ScopedDatabase,
    private readonly providerId: string,
    private readonly providerInstanceId: string,
    private readonly allowedCredentialBindings: ReadonlyArray<{
      name: string;
      credentialId: string;
      revision: number;
    }>,
    private readonly encryptionKey?: string,
  ) {}

  async resolve(reference: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw signal.reason ?? new Error("Secret resolution was cancelled");
    if (reference.startsWith("pending:"))
      throw new Error("The provider credential is not configured");
    if (!this.encryptionKey)
      throw new Error("CREDENTIAL_ENCRYPTION_KEY is required for provider execution");
    const binding = this.allowedCredentialBindings.find((item) => item.credentialId === reference);
    if (!binding) throw new Error("The provider credential reference is not pinned to this run");
    const row = await this.scoped.run(async (tx) => {
      const rows = await tx
        .select()
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.id, reference),
            eq(providerCredentials.workspaceId, this.scoped.scope.workspaceId),
            eq(providerCredentials.provider, this.providerId),
            eq(providerCredentials.providerInstanceId, this.providerInstanceId),
            eq(providerCredentials.secretRevision, binding.revision),
            eq(providerCredentials.status, "active"),
            or(
              isNull(providerCredentials.userId),
              eq(providerCredentials.userId, this.scoped.scope.actorId),
            ),
          ),
        )
        .limit(1);
      return rows[0];
    });
    if (!row) throw new Error("The provider credential was rotated or revoked");
    if (row.keyVersion !== SUPPORTED_CREDENTIAL_KEY_VERSION)
      throw new Error("The provider credential uses an unsupported encryption key version");
    return decryptCredentialEnvelope(row.encryptedValue, this.encryptionKey, {
      workspaceId: row.workspaceId,
      actorId: row.createdBy ?? row.userId ?? this.scoped.scope.actorId,
      providerInstanceId: this.providerInstanceId,
      secretName: row.credentialKind,
      revision: row.secretRevision,
    });
  }
}
