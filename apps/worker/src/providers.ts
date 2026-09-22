import { createDecipheriv } from "node:crypto";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { ProviderRegistry, type ProviderScope } from "@openmuse/core";
import {
  ScopedDatabase,
  providerCredentials,
  providerInstances,
  type OpenMuseDatabase,
} from "@openmuse/db";
import type {
  ModelClient,
  ModelConfig,
  ModelDriver,
  ModelEvent,
  ModelGenerateRequest,
  ProviderConfigDefinition,
  ProviderCreateContext,
  ProviderOperationContext,
  ProviderSecretResolver,
} from "@openmuse/provider-contracts";
import { createAppConnectConnectorDriver } from "@openmuse/provider-connector-appconnect";
import { createMetaModelDriver } from "@openmuse/provider-model-meta";
import { createOllamaModelDriver } from "@openmuse/provider-model-ollama";
import { createOpenAiCompatibleModelDriver } from "@openmuse/provider-model-openai-compatible";
import { createExaSearchDriver } from "@openmuse/provider-search-exa";
import { createTavilySearchDriver } from "@openmuse/provider-search-tavily";
import type { ConversationTaskPayload, ResolvedModel } from "@openmuse/application";
import type { TaskExecutionContext } from "@openmuse/application";
import type { Task } from "@openmuse/db";

interface ProviderRuntimeOptions {
  db: OpenMuseDatabase;
  encryptionKey?: string;
  deterministic?: boolean;
  deterministicResponse?: string;
}

interface SelectedProviderInstance {
  id: string;
  providerId: string;
  module: string;
  config: Record<string, unknown>;
  credentialBindings: Array<{ name: string; credentialId: string }>;
  configDigest: string;
}

/**
 * The worker owns the only provider composition root. API code persists a
 * provider instance and credential binding; this runtime resolves that
 * metadata under the task's tenant/actor scope and only then constructs a
 * provider client. Provider packages never receive a database connection.
 */
export class WorkerProviderRuntime {
  private readonly registry: ProviderRegistry;

  constructor(private readonly options: ProviderRuntimeOptions) {
    this.registry = createBuiltinProviderRegistry({
      deterministic: options.deterministic,
      deterministicResponse: options.deterministicResponse,
    });
  }

  async resolveModel(
    payload: ConversationTaskPayload,
    context: TaskExecutionContext,
    task: Task,
  ): Promise<ResolvedModel> {
    const selected = await this.selectModelInstance(payload, task);
    if (!selected) {
      if (this.options.deterministic) return this.resolveDeterministic(context, task);
      throw new Error("No available model provider instance is configured for this workspace");
    }

    if (selected.module !== "model") throw new Error("The selected provider is not a model");
    const scoped = new ScopedDatabase(this.options.db, {
      workspaceId: task.workspaceId,
      actorId: task.requestedBy,
    });
    const config = applyCredentialBindings(selected.config, selected.credentialBindings);
    const secrets = new DatabaseSecretResolver(
      scoped,
      selected.providerId,
      new Set(selected.credentialBindings.map((binding) => binding.credentialId)),
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

  private async selectModelInstance(
    payload: ConversationTaskPayload,
    task: Task,
  ): Promise<SelectedProviderInstance | undefined> {
    const scoped = new ScopedDatabase(this.options.db, {
      workspaceId: task.workspaceId,
      actorId: task.requestedBy,
    });
    return scoped.run(async (tx) => {
      const filters = [
        eq(providerInstances.workspaceId, task.workspaceId),
        eq(providerInstances.module, "model"),
        eq(providerInstances.status, "available"),
        or(isNull(providerInstances.userId), eq(providerInstances.userId, task.requestedBy)),
        ...(payload.providerInstanceId
          ? [eq(providerInstances.id, payload.providerInstanceId)]
          : []),
        ...(payload.providerId ? [eq(providerInstances.providerId, payload.providerId)] : []),
      ];
      const rows = await tx
        .select()
        .from(providerInstances)
        .where(and(...filters))
        .orderBy(desc(providerInstances.updatedAt))
        .limit(1);
      const row = rows[0];
      if (!row) return undefined;
      return {
        id: row.id,
        providerId: row.providerId,
        module: row.module,
        config: row.config,
        credentialBindings: row.credentialBindings,
        configDigest: row.configDigest,
      };
    });
  }

  private async resolveDeterministic(
    context: TaskExecutionContext,
    task: Task,
  ): Promise<ResolvedModel> {
    const scope = this.registry.createScope({
      scopeId: `task:${task.id}`,
      tenantId: task.workspaceId,
      workspaceId: task.workspaceId,
      userId: task.requestedBy,
      runId: task.runId ?? undefined,
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

export function createBuiltinProviderRegistry(
  options: {
    deterministic?: boolean;
    deterministicResponse?: string;
  } = {},
): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(createOpenAiCompatibleModelDriver());
  registry.register(createMetaModelDriver());
  registry.register(createOllamaModelDriver());
  registry.register(createTavilySearchDriver());
  registry.register(createExaSearchDriver());
  registry.register(createAppConnectConnectorDriver());
  if (options.deterministic)
    registry.register(createDeterministicModelDriver(options.deterministicResponse));
  return registry;
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

function applyCredentialBindings(
  config: Record<string, unknown>,
  bindings: readonly { name: string; credentialId: string }[],
): Record<string, unknown> {
  const next = { ...config };
  for (const binding of bindings) {
    if (!binding.name.trim() || !binding.credentialId.trim())
      throw new Error("A provider credential binding is invalid");
    // Provider configs contain only opaque credential references. The secret
    // resolver turns the reference into plaintext inside the provider call.
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
    private readonly allowedCredentialIds: ReadonlySet<string>,
    private readonly encryptionKey?: string,
  ) {}

  async resolve(reference: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw signal.reason ?? new Error("Secret resolution was cancelled");
    if (!this.allowedCredentialIds.has(reference))
      throw new Error("The provider credential reference is not bound to this instance");
    if (!this.encryptionKey)
      throw new Error("CREDENTIAL_ENCRYPTION_KEY is required for provider execution");
    const row = await this.scoped.run(async (tx) => {
      const rows = await tx
        .select()
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.id, reference),
            eq(providerCredentials.workspaceId, this.scoped.scope.workspaceId),
            eq(providerCredentials.provider, this.providerId),
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
    if (!row) throw new Error("The provider credential is unavailable");
    return decryptCredential(row.encryptedValue, this.encryptionKey);
  }
}

function decryptCredential(value: string, encodedKey: string): string {
  const key = decodeKey(encodedKey);
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1")
    throw new Error("The provider credential has an unsupported encryption format");
  const iv = decodeBase64Url(parts[1]);
  const tag = decodeBase64Url(parts[2]);
  const ciphertext = decodeBase64Url(parts[3]);
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error("The provider credential encryption envelope is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function decodeKey(value: string): Buffer {
  const decoded = decodeBase64Url(value);
  if (decoded.length !== 32) throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes");
  return decoded;
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
