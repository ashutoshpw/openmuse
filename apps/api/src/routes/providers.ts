import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { ApplicationError } from "@openmuse/application";
import {
  createProviderCredentialInputSchema,
  createProviderInstanceInputSchema,
  listProviderCredentialsInputSchema,
  listProviderInstancesInputSchema,
  listProvidersInputSchema,
  setupProviderInstanceInputSchema,
  updateProviderCredentialInputSchema,
  updateProviderInstanceInputSchema,
  type ProviderCredential,
  type ProviderInstance,
  type ProviderModule,
} from "@openmuse/contracts";
import {
  ProviderCredentialRepository,
  ProviderInstanceRepository,
  RepositoryError,
  ScopedDatabase,
  WorkspaceDirectoryRepository,
  resolveResourceWorkspace,
  type DatabaseClient,
  type ProviderBinding,
} from "@openmuse/db";
import {
  ProviderCatalog,
  SUPPORTED_CREDENTIAL_KEY_VERSION,
  type ProviderCatalogEntry,
  encryptCredentialEnvelope,
} from "@openmuse/provider-server";
import { envelope, jsonError, parseJson, type ApiContext, type ApiEnv } from "../http.js";

type InstancePageInput = {
  limit: number;
  cursor?: string;
  module?: ProviderModule;
  scope?: "system" | "workspace" | "user";
  includeUnavailable: boolean;
};

type CredentialPageInput = {
  limit: number;
  cursor?: string;
  providerId?: string;
  providerInstanceId?: string;
  scope?: "workspace" | "user";
  status?: "active" | "revoked";
};

export interface ProviderRouteOptions {
  db: DatabaseClient;
  catalog?: ProviderCatalog;
  credentialEncryptionKey?: string;
}

function routeError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof RepositoryError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "forbidden"
          ? 403
          : error.code === "invalid"
            ? 400
            : 409;
    return new ApplicationError(
      error.message,
      error.code === "invalid" || error.code === "expired" ? "invalid_request" : error.code,
      status,
    );
  }
  return new ApplicationError("The provider request could not be completed.", "internal", 500);
}

function requireCatalog(options: ProviderRouteOptions): ProviderCatalog {
  if (!options.catalog)
    throw new ApplicationError(
      "Provider configuration is unavailable",
      "provider_unavailable",
      409,
    );
  return options.catalog;
}

function requireEncryptionKey(options: ProviderRouteOptions): string {
  if (!options.credentialEncryptionKey)
    throw new ApplicationError("Provider credential encryption is not configured", "internal", 500);
  return options.credentialEncryptionKey;
}

function providerScope(row: { userId: string | null }): "workspace" | "user" {
  return row.userId === null ? "workspace" : "user";
}

function catalogEntry(catalog: ProviderCatalog, module: ProviderModule, providerId: string) {
  let entry: ProviderCatalogEntry;
  try {
    entry = catalog.get(module, providerId);
  } catch {
    throw new ApplicationError("The selected provider is unavailable", "provider_unavailable", 409);
  }
  if (!entry.trusted)
    throw new ApplicationError("The selected provider is not trusted", "provider_unavailable", 409);
  return entry;
}

function normalizeConfig(
  catalog: ProviderCatalog,
  module: ProviderModule,
  providerId: string,
  raw: unknown,
): Record<string, unknown> {
  try {
    return catalog.normalizeConfig(module, providerId, raw);
  } catch {
    throw new ApplicationError("The provider configuration is invalid", "invalid_request", 400);
  }
}

const PENDING_SECRET_PREFIX = "pending:";

function assertNoSecretConfigOverrides(
  entry: ProviderCatalogEntry,
  raw: Record<string, unknown>,
): void {
  const secretNames = new Set(entry.requiredSecrets.map((secret) => secret.name));
  if (Object.keys(raw).some((name) => secretNames.has(name)))
    throw new ApplicationError(
      "Provider credentials must be supplied through credentialBindings",
      "invalid_request",
      400,
    );
}

function configWithCredentialReferences(
  catalog: ProviderCatalog,
  entry: ProviderCatalogEntry,
  raw: Record<string, unknown>,
  bindings: readonly ProviderBinding[],
): Record<string, unknown> {
  const candidate = { ...raw };
  for (const secret of entry.requiredSecrets) {
    delete candidate[secret.name];
    const binding = bindings.find((item) => item.name === secret.name);
    if (binding) candidate[secret.name] = binding.credentialId;
    else if (secret.required) candidate[secret.name] = `${PENDING_SECRET_PREFIX}${secret.name}`;
  }
  return normalizeConfig(catalog, entry.module, entry.providerId, candidate);
}

function assertBindingNames(
  entry: ProviderCatalogEntry,
  bindings: readonly { name: string; credentialId: string }[],
): void {
  const names = new Set(entry.requiredSecrets.map((secret) => secret.name));
  for (const binding of bindings) {
    if (!names.has(binding.name))
      throw new ApplicationError(
        `Credential binding ${binding.name} is not declared by the provider`,
        "invalid_request",
        400,
      );
  }
}

function assertCredentialKind(entry: ProviderCatalogEntry, credentialKind: string): void {
  if (!entry.requiredSecrets.some((secret) => secret.name === credentialKind))
    throw new ApplicationError(
      "Credential kind is not declared by the selected provider",
      "invalid_request",
      400,
    );
}

function assertSetupSecretNames(
  entry: ProviderCatalogEntry,
  secrets: Readonly<Record<string, string>> | undefined,
): void {
  if (!secrets) return;
  const declared = new Set(entry.requiredSecrets.map((secret) => secret.name));
  for (const name of Object.keys(secrets)) {
    if (!declared.has(name))
      throw new ApplicationError(
        `Provider secret ${name} is not declared by the provider`,
        "invalid_request",
        400,
      );
  }
}

function assertReadyForDefault(
  entry: ProviderCatalogEntry,
  bindings: readonly ProviderBinding[],
): void {
  const missing = entry.requiredSecrets.some(
    (secret) =>
      secret.required &&
      !bindings.some((binding) => binding.name === secret.name && binding.revision > 0),
  );
  if (missing)
    throw new ApplicationError(
      "Provider credentials must be configured before selecting a default provider",
      "provider_auth_required",
      409,
    );
}

function pageInput(c: ApiContext, kind: "instances" | "credentials") {
  const bool = c.req.query("includeUnavailable");
  const raw = {
    ...(c.req.query("limit") === undefined ? {} : { limit: Number(c.req.query("limit")) }),
    ...(c.req.query("cursor") === undefined ? {} : { cursor: c.req.query("cursor") }),
    ...(c.req.query("module") === undefined ? {} : { module: c.req.query("module") }),
    ...(c.req.query("scope") === undefined ? {} : { scope: c.req.query("scope") }),
    ...(c.req.query("providerId") === undefined ? {} : { providerId: c.req.query("providerId") }),
    ...(c.req.query("status") === undefined ? {} : { status: c.req.query("status") }),
    ...(bool === undefined ? {} : { includeUnavailable: bool === "true" }),
  };
  const parsed =
    kind === "instances"
      ? listProviderInstancesInputSchema.safeParse(raw)
      : listProviderCredentialsInputSchema.safeParse(raw);
  if (!parsed.success)
    throw new ApplicationError("Invalid provider pagination query", "invalid_request", 400);
  return parsed.data;
}

function routeParam(c: ApiContext, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new ApplicationError(`${name} is required`, "invalid_request", 400);
  return value;
}

async function actorWorkspaces(options: ProviderRouteOptions, actorId: string) {
  return new WorkspaceDirectoryRepository(options.db.db).list(actorId);
}

async function assertWorkspaceVisible(
  options: ProviderRouteOptions,
  actorId: string,
  workspaceId: string,
): Promise<string> {
  const rows = await actorWorkspaces(options, actorId);
  if (!rows.some((row) => row.id === workspaceId))
    throw new ApplicationError("Workspace not found", "not_found", 404);
  return workspaceId;
}

async function resolveWorkspace(
  c: ApiContext,
  options: ProviderRouteOptions,
  explicit?: string,
): Promise<string> {
  const actorId = c.get("identity").userId;
  const requested = explicit ?? c.req.header("x-openmuse-workspace") ?? c.req.query("workspaceId");
  if (requested) return assertWorkspaceVisible(options, actorId, requested);
  const rows = await actorWorkspaces(options, actorId);
  if (rows.length !== 1)
    throw new ApplicationError(
      "workspaceId is required when the account has multiple workspaces",
      "invalid_request",
      400,
    );
  return rows[0]!.id;
}

async function optionalWorkspace(
  c: ApiContext,
  options: ProviderRouteOptions,
): Promise<string | undefined> {
  const actorId = c.get("identity").userId;
  const requested = c.req.header("x-openmuse-workspace") ?? c.req.query("workspaceId");
  if (requested) return assertWorkspaceVisible(options, actorId, requested);
  const rows = await actorWorkspaces(options, actorId);
  return rows.length === 1 ? rows[0]!.id : undefined;
}

function instanceResource(
  row: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    workspaceId: string | null;
    userId: string | null;
    providerId: string;
    module: string;
    displayName: string;
    status: string;
    config: Record<string, unknown>;
    credentialBindings: ProviderBinding[];
    version: string;
    configVersion: string;
    configDigest: string;
    metadata: Record<string, unknown>;
  },
  catalog: ProviderCatalog,
  isDefault: boolean,
): ProviderInstance {
  let entry: ProviderCatalogEntry | undefined;
  try {
    entry = catalog.get(row.module as ProviderModule, row.providerId);
  } catch {
    entry = undefined;
  }
  const requiredSecrets = (entry?.requiredSecrets ?? []).map((secret) => ({
    name: secret.name,
    required: secret.required,
    configured: row.credentialBindings.some(
      (binding) => binding.name === secret.name && binding.revision > 0,
    ),
  }));
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    workspaceId: row.workspaceId,
    scope: providerScope(row),
    ownerUserId: row.userId,
    providerId: row.providerId,
    module: row.module as ProviderModule,
    displayName: row.displayName,
    status: row.status as ProviderInstance["status"],
    version: row.version,
    configVersion: row.configVersion,
    configDigest: row.configDigest,
    capabilities: (entry?.capabilities ?? []).map(({ key, description }) => ({
      key,
      ...(description === undefined ? {} : { description }),
    })),
    requiredSecrets,
    isDefault,
    metadata: row.metadata as ProviderInstance["metadata"],
  };
}

function catalogResource(entry: ProviderCatalogEntry, catalog: ProviderCatalog): ProviderInstance {
  const now = new Date().toISOString();
  let config: Record<string, unknown> = {};
  try {
    config = catalog.normalizeConfig(entry.module, entry.providerId, {});
  } catch {
    // The catalogue is still useful for unavailable providers whose defaults
    // cannot be parsed in this deployment. They remain visibly unavailable.
  }
  const configDigest = catalog.digest({
    module: entry.module,
    providerId: entry.providerId,
    version: entry.version,
    configVersion: entry.configVersion,
    buildDigest: entry.buildDigest,
    config,
    credentialBindings: [],
  });
  return {
    id: `system:${entry.module}:${entry.providerId}`,
    createdAt: now,
    updatedAt: now,
    workspaceId: null,
    scope: "system",
    ownerUserId: null,
    providerId: entry.providerId,
    module: entry.module,
    displayName: entry.displayName,
    status: entry.trusted ? "available" : "unavailable",
    version: entry.version,
    configVersion: entry.configVersion,
    configDigest,
    capabilities: entry.capabilities.map(({ key, description }) => ({
      key,
      ...(description === undefined ? {} : { description }),
    })),
    requiredSecrets: entry.requiredSecrets.map(({ name, required }) => ({
      name,
      required,
      configured: false,
    })),
    isDefault: false,
    metadata: { system: true, trusted: entry.trusted },
  };
}

function credentialResource(row: {
  id: string;
  workspaceId: string;
  providerInstanceId: string | null;
  userId: string | null;
  provider: string;
  credentialKind: string;
  keyVersion: number;
  secretRevision: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): ProviderCredential {
  if (!row.providerInstanceId)
    throw new ApplicationError(
      "Provider credential is not attached to an instance",
      "conflict",
      409,
    );
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    workspaceId: row.workspaceId,
    providerInstanceId: row.providerInstanceId,
    scope: row.userId === null ? "workspace" : "user",
    ownerUserId: row.userId,
    providerId: row.provider,
    credentialKind: row.credentialKind,
    keyVersion: row.keyVersion,
    secretRevision: row.secretRevision,
    status: row.status as ProviderCredential["status"],
  };
}

async function resolveBindings(
  scoped: ScopedDatabase,
  providerInstanceId: string,
  providerId: string,
  bindings: readonly { name: string; credentialId: string }[],
): Promise<ProviderBinding[]> {
  const credentials = new ProviderCredentialRepository(scoped);
  const seen = new Set<string>();
  const resolved: ProviderBinding[] = [];
  for (const binding of bindings) {
    if (seen.has(binding.name))
      throw new ApplicationError(
        "Provider credential names must be unique",
        "invalid_request",
        400,
      );
    seen.add(binding.name);
    const credential = await credentials.get(binding.credentialId);
    if (
      credential.provider !== providerId ||
      credential.providerInstanceId !== providerInstanceId ||
      credential.credentialKind !== binding.name
    )
      throw new ApplicationError(
        "Provider credentials must belong to the selected active instance",
        "forbidden",
        403,
      );
    if (credential.status !== "active")
      throw new ApplicationError(
        "Provider credential changed while the provider was being configured",
        "conflict",
        409,
      );
    resolved.push({
      name: binding.name,
      credentialId: credential.id,
      revision: credential.secretRevision,
    });
  }
  return resolved;
}

function computeConfigDigest(
  catalog: ProviderCatalog,
  entry: ProviderCatalogEntry,
  config: Record<string, unknown>,
  bindings: readonly ProviderBinding[],
): string {
  return catalog.digest({
    module: entry.module,
    providerId: entry.providerId,
    version: entry.version,
    configVersion: entry.configVersion,
    buildDigest: entry.buildDigest,
    config,
    credentialBindings: bindings,
  });
}

export function registerProviderRoutes(app: Hono<ApiEnv>, options: ProviderRouteOptions): void {
  app.get("/api/v1/providers", async (c) => {
    try {
      const catalog = requireCatalog(options);
      const parsed = listProvidersInputSchema.safeParse({
        ...(c.req.query("module") === undefined ? {} : { module: c.req.query("module") }),
        ...(c.req.query("includeUnavailable") === undefined
          ? {}
          : { includeUnavailable: c.req.query("includeUnavailable") === "true" }),
      });
      if (!parsed.success)
        throw new ApplicationError("Invalid provider query", "invalid_request", 400);
      const module = parsed.data.module;
      const includeUnavailable = parsed.data.includeUnavailable;
      const entries = catalog
        .list(module)
        .filter((entry) => includeUnavailable || entry.trusted)
        .map((entry) => catalogResource(entry, catalog));
      const workspaceId = await optionalWorkspace(c, options);
      if (!workspaceId) return envelope(c, { items: entries }, c.get("requestId"));
      const scoped = new ScopedDatabase(options.db.db, {
        workspaceId,
        actorId: c.get("identity").userId,
      });
      const repository = new ProviderInstanceRepository(scoped);
      const rows = await repository.list({
        includeUnavailable: true,
        ...(module ? { module } : {}),
      });
      const configured = await Promise.all(
        rows.map(async (row) => instanceResource(row, catalog, await repository.isDefault(row.id))),
      );
      return envelope(c, { items: [...entries, ...configured] }, c.get("requestId"));
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });

  const listInstances = async (c: ApiContext, workspaceId?: string) => {
    const catalog = requireCatalog(options);
    const query = pageInput(c, "instances") as InstancePageInput;
    const resolvedWorkspace = await resolveWorkspace(c, options, workspaceId);
    const scoped = new ScopedDatabase(options.db.db, {
      workspaceId: resolvedWorkspace,
      actorId: c.get("identity").userId,
    });
    const repository = new ProviderInstanceRepository(scoped);
    const rows = await repository.list({
      ...(query.module ? { module: query.module } : {}),
      ...(query.scope && query.scope !== "system" ? { scope: query.scope } : {}),
      includeUnavailable: query.includeUnavailable,
    });
    const mapped = await Promise.all(
      rows.map(async (row) => instanceResource(row, catalog, await repository.isDefault(row.id))),
    );
    const start = query.cursor ? Number(query.cursor) : 0;
    const selected = mapped.slice(start, start + query.limit + 1);
    return envelope(
      c,
      {
        items: selected.slice(0, query.limit),
        page: {
          nextCursor: selected.length > query.limit ? String(start + query.limit) : null,
          hasMore: selected.length > query.limit,
        },
      },
      c.get("requestId"),
    );
  };
  app.get("/api/v1/provider-instances", async (c) => {
    try {
      return await listInstances(c);
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
  app.get("/api/v1/workspaces/:workspaceId/provider-instances", async (c) => {
    try {
      return await listInstances(c, routeParam(c, "workspaceId"));
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });

  const createInstance = async (c: ApiContext, workspaceId?: string) => {
    const catalog = requireCatalog(options);
    const parsed = createProviderInstanceInputSchema.safeParse(await parseJson(c));
    if (!parsed.success)
      throw new ApplicationError("Invalid provider instance input", "invalid_request", 400);
    const resolvedWorkspace = await resolveWorkspace(c, options, workspaceId);
    const entry = catalogEntry(catalog, parsed.data.module, parsed.data.providerId);
    assertNoSecretConfigOverrides(entry, parsed.data.config);
    assertBindingNames(entry, parsed.data.credentialBindings);
    const id = randomUUID();
    const scoped = new ScopedDatabase(options.db.db, {
      workspaceId: resolvedWorkspace,
      actorId: c.get("identity").userId,
    });
    const bindings = await resolveBindings(
      scoped,
      id,
      entry.providerId,
      parsed.data.credentialBindings,
    );
    if (parsed.data.isDefault) assertReadyForDefault(entry, bindings);
    const config = configWithCredentialReferences(catalog, entry, parsed.data.config, bindings);
    const row = await new ProviderInstanceRepository(scoped).create({
      id,
      providerId: entry.providerId,
      module: entry.module,
      scope: parsed.data.scope === "user" ? "user" : "workspace",
      displayName: parsed.data.displayName ?? entry.displayName,
      config,
      credentialBindings: bindings,
      version: entry.version,
      configVersion: entry.configVersion,
      configDigest: computeConfigDigest(catalog, entry, config, bindings),
      metadata: { trusted: entry.trusted },
      isDefault: parsed.data.isDefault,
    });
    return envelope(
      c,
      instanceResource(
        row,
        catalog,
        await new ProviderInstanceRepository(scoped).isDefault(row.id),
      ),
      c.get("requestId"),
    );
  };
  app.post("/api/v1/provider-instances", async (c) => {
    try {
      return await createInstance(c);
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
  app.post("/api/v1/workspaces/:workspaceId/provider-instances", async (c) => {
    try {
      return await createInstance(c, routeParam(c, "workspaceId"));
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });

  const getInstance = async (c: ApiContext, workspaceId?: string) => {
    const catalog = requireCatalog(options);
    const resolvedWorkspace = await resolveWorkspace(c, options, workspaceId);
    const scoped = new ScopedDatabase(options.db.db, {
      workspaceId: resolvedWorkspace,
      actorId: c.get("identity").userId,
    });
    const repository = new ProviderInstanceRepository(scoped);
    const row = await repository.get(routeParam(c, "providerInstanceId"));
    return envelope(
      c,
      instanceResource(row, catalog, await repository.isDefault(row.id)),
      c.get("requestId"),
    );
  };
  app.get("/api/v1/provider-instances/:providerInstanceId", async (c) => {
    try {
      return await getInstance(c);
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
  app.get("/api/v1/workspaces/:workspaceId/provider-instances/:providerInstanceId", async (c) => {
    try {
      return await getInstance(c, routeParam(c, "workspaceId"));
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });

  const setupInstance = async (c: ApiContext, workspaceId?: string) => {
    const catalog = requireCatalog(options);
    const parsed = setupProviderInstanceInputSchema.safeParse(await parseJson(c));
    if (!parsed.success)
      throw new ApplicationError("Invalid provider setup input", "invalid_request", 400);
    const resolvedWorkspace = await resolveWorkspace(c, options, workspaceId);
    const scoped = new ScopedDatabase(options.db.db, {
      workspaceId: resolvedWorkspace,
      actorId: c.get("identity").userId,
    });
    const repository = new ProviderInstanceRepository(scoped);
    const id = routeParam(c, "providerInstanceId");
    const current = await repository.getForMutation(id);
    const entry = catalogEntry(catalog, current.module as ProviderModule, current.providerId);
    if (parsed.data.config !== undefined) assertNoSecretConfigOverrides(entry, parsed.data.config);
    assertSetupSecretNames(entry, parsed.data.secrets);
    const secretValues = parsed.data.secrets ?? {};
    const encryptionKey =
      Object.keys(secretValues).length > 0 ? requireEncryptionKey(options) : undefined;
    const actorId = c.get("identity").userId;
    const row = await repository.setup(id, {
      expectedConfigDigest: parsed.data.expectedConfigDigest,
      ...(parsed.data.config === undefined ? {} : { config: parsed.data.config }),
      ...(parsed.data.displayName === undefined ? {} : { displayName: parsed.data.displayName }),
      secrets: secretValues,
      declaredSecretNames: entry.requiredSecrets.map((secret) => secret.name),
      buildConfig: (currentConfig, requestedConfig, bindings) =>
        configWithCredentialReferences(
          catalog,
          entry,
          requestedConfig === undefined ? currentConfig : { ...currentConfig, ...requestedConfig },
          bindings,
        ),
      computeConfigDigest: (config, bindings) =>
        computeConfigDigest(catalog, entry, config, bindings),
      assertReadyForDefault: (bindings) => assertReadyForDefault(entry, bindings),
      encryptSecret: ({
        value,
        workspaceId: credentialWorkspaceId,
        providerInstanceId,
        secretName,
        revision,
        createdBy,
        userId,
      }) => {
        if (!encryptionKey)
          throw new ApplicationError(
            "Provider credential encryption is not configured",
            "internal",
            500,
          );
        return encryptCredentialEnvelope(value, encryptionKey, {
          workspaceId: credentialWorkspaceId,
          actorId: createdBy ?? userId ?? actorId,
          providerInstanceId,
          secretName,
          revision,
        });
      },
    });
    return envelope(
      c,
      instanceResource(row, catalog, await repository.isDefault(row.id)),
      c.get("requestId"),
    );
  };
  app.post("/api/v1/provider-instances/:providerInstanceId/setup", async (c) => {
    try {
      return await setupInstance(c);
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
  app.post(
    "/api/v1/workspaces/:workspaceId/provider-instances/:providerInstanceId/setup",
    async (c) => {
      try {
        return await setupInstance(c, routeParam(c, "workspaceId"));
      } catch (error) {
        return jsonError(c, routeError(error), c.get("requestId"));
      }
    },
  );

  const updateInstance = async (c: ApiContext, workspaceId?: string) => {
    const catalog = requireCatalog(options);
    const parsed = updateProviderInstanceInputSchema.safeParse(await parseJson(c));
    if (!parsed.success)
      throw new ApplicationError("Invalid provider instance input", "invalid_request", 400);
    const resolvedWorkspace = await resolveWorkspace(c, options, workspaceId);
    const scoped = new ScopedDatabase(options.db.db, {
      workspaceId: resolvedWorkspace,
      actorId: c.get("identity").userId,
    });
    const repository = new ProviderInstanceRepository(scoped);
    const id = routeParam(c, "providerInstanceId");
    const current = await repository.getForMutation(id);
    const entry = catalogEntry(catalog, current.module as ProviderModule, current.providerId);
    if (parsed.data.config !== undefined) assertNoSecretConfigOverrides(entry, parsed.data.config);
    let bindings = current.credentialBindings;
    if (parsed.data.credentialBindings !== undefined) {
      assertBindingNames(entry, parsed.data.credentialBindings);
      bindings = await resolveBindings(
        scoped,
        id,
        entry.providerId,
        parsed.data.credentialBindings,
      );
    }
    const currentIsDefault = await repository.isDefault(id);
    const remainsDefault =
      parsed.data.isDefault === true || (currentIsDefault && parsed.data.isDefault !== false);
    if (parsed.data.credentialBindings === undefined && remainsDefault)
      bindings = await resolveBindings(scoped, id, entry.providerId, bindings);
    if (remainsDefault) assertReadyForDefault(entry, bindings);
    const config = configWithCredentialReferences(
      catalog,
      entry,
      parsed.data.config === undefined
        ? current.config
        : { ...current.config, ...parsed.data.config },
      bindings,
    );
    const changed =
      parsed.data.config !== undefined || parsed.data.credentialBindings !== undefined;
    const row = await repository.update(id, {
      ...(parsed.data.displayName === undefined ? {} : { displayName: parsed.data.displayName }),
      ...(parsed.data.enabled === undefined ? {} : { enabled: parsed.data.enabled }),
      ...(parsed.data.isDefault === undefined ? {} : { isDefault: parsed.data.isDefault }),
      ...(changed
        ? {
            config,
            credentialBindings: bindings,
            version: entry.version,
            configVersion: entry.configVersion,
            configDigest: computeConfigDigest(catalog, entry, config, bindings),
          }
        : {}),
      ...(parsed.data.expectedConfigDigest === undefined
        ? {}
        : { expectedConfigDigest: parsed.data.expectedConfigDigest }),
    });
    return envelope(
      c,
      instanceResource(row, catalog, await repository.isDefault(row.id)),
      c.get("requestId"),
    );
  };
  app.patch("/api/v1/provider-instances/:providerInstanceId", async (c) => {
    try {
      return await updateInstance(c);
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
  app.patch("/api/v1/workspaces/:workspaceId/provider-instances/:providerInstanceId", async (c) => {
    try {
      return await updateInstance(c, routeParam(c, "workspaceId"));
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });

  const deleteInstance = async (c: ApiContext, workspaceId?: string) => {
    const resolvedWorkspace = await resolveWorkspace(c, options, workspaceId);
    const scoped = new ScopedDatabase(options.db.db, {
      workspaceId: resolvedWorkspace,
      actorId: c.get("identity").userId,
    });
    await new ProviderInstanceRepository(scoped).revoke(routeParam(c, "providerInstanceId"));
    return c.body(null, 204);
  };
  app.delete("/api/v1/provider-instances/:providerInstanceId", async (c) => {
    try {
      return await deleteInstance(c);
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
  app.delete(
    "/api/v1/workspaces/:workspaceId/provider-instances/:providerInstanceId",
    async (c) => {
      try {
        return await deleteInstance(c, routeParam(c, "workspaceId"));
      } catch (error) {
        return jsonError(c, routeError(error), c.get("requestId"));
      }
    },
  );

  const credentialWorkspace = async (c: ApiContext, providerInstanceId?: string) => {
    if (providerInstanceId) {
      const resolved = await resolveResourceWorkspace(
        options.db.db,
        "provider_instance",
        providerInstanceId,
        c.get("identity").userId,
      );
      if (!resolved) throw new ApplicationError("Provider instance not found", "not_found", 404);
      return resolved;
    }
    return resolveWorkspace(c, options);
  };

  const listCredentials = async (c: ApiContext, workspaceId?: string) => {
    const query = pageInput(c, "credentials") as CredentialPageInput;
    const resolvedWorkspace = workspaceId
      ? await resolveWorkspace(c, options, workspaceId)
      : await credentialWorkspace(c, query.providerInstanceId);
    if (workspaceId && resolvedWorkspace !== workspaceId)
      throw new ApplicationError("Provider instance not found", "not_found", 404);
    const scoped = new ScopedDatabase(options.db.db, {
      workspaceId: workspaceId ?? resolvedWorkspace,
      actorId: c.get("identity").userId,
    });
    const rows = await new ProviderCredentialRepository(scoped).list({
      ...(query.providerId ? { providerId: query.providerId } : {}),
      ...(query.providerInstanceId ? { providerInstanceId: query.providerInstanceId } : {}),
      ...(query.scope ? { scope: query.scope } : {}),
      ...(query.status ? { status: query.status } : {}),
    });
    const start = query.cursor ? Number(query.cursor) : 0;
    const selected = rows.slice(start, start + query.limit + 1);
    return envelope(
      c,
      {
        items: selected.slice(0, query.limit).map(credentialResource),
        page: {
          nextCursor: selected.length > query.limit ? String(start + query.limit) : null,
          hasMore: selected.length > query.limit,
        },
      },
      c.get("requestId"),
    );
  };
  app.get("/api/v1/provider-credentials", async (c) => {
    try {
      return await listCredentials(c);
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
  app.get("/api/v1/workspaces/:workspaceId/provider-credentials", async (c) => {
    try {
      return await listCredentials(c, routeParam(c, "workspaceId"));
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });

  const getCredential = async (c: ApiContext, workspaceId?: string) => {
    const resolvedWorkspace = await credentialWorkspace(c);
    if (workspaceId && resolvedWorkspace !== workspaceId)
      throw new ApplicationError("Provider credential not found", "not_found", 404);
    const scoped = new ScopedDatabase(options.db.db, {
      workspaceId: workspaceId ?? resolvedWorkspace,
      actorId: c.get("identity").userId,
    });
    return envelope(
      c,
      credentialResource(
        await new ProviderCredentialRepository(scoped).get(routeParam(c, "credentialId")),
      ),
      c.get("requestId"),
    );
  };
  app.get("/api/v1/provider-credentials/:credentialId", async (c) => {
    try {
      return await getCredential(c);
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
  app.get("/api/v1/workspaces/:workspaceId/provider-credentials/:credentialId", async (c) => {
    try {
      return await getCredential(c, routeParam(c, "workspaceId"));
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });

  const createCredential = async (c: ApiContext, workspaceId?: string) => {
    const parsed = createProviderCredentialInputSchema.safeParse(await parseJson(c));
    if (!parsed.success)
      throw new ApplicationError("Invalid provider credential input", "invalid_request", 400);
    const resolvedWorkspace = await credentialWorkspace(c, parsed.data.providerInstanceId);
    if (workspaceId && resolvedWorkspace !== workspaceId)
      throw new ApplicationError("Provider instance not found", "not_found", 404);
    const scoped = new ScopedDatabase(options.db.db, {
      workspaceId: workspaceId ?? resolvedWorkspace,
      actorId: c.get("identity").userId,
    });
    const instance = await new ProviderInstanceRepository(scoped).getForMutation(
      parsed.data.providerInstanceId,
    );
    if (instance.providerId !== parsed.data.providerId)
      throw new ApplicationError(
        "Credential provider does not match instance",
        "invalid_request",
        400,
      );
    const catalog = catalogEntry(
      requireCatalog(options),
      instance.module as ProviderModule,
      instance.providerId,
    );
    assertCredentialKind(catalog, parsed.data.credentialKind);
    const key = requireEncryptionKey(options);
    const createdBy = c.get("identity").userId;
    const encryptedValue = encryptCredentialEnvelope(parsed.data.secret, key, {
      workspaceId: resolvedWorkspace,
      actorId: createdBy,
      providerInstanceId: parsed.data.providerInstanceId,
      secretName: parsed.data.credentialKind,
      revision: 1,
    });
    const row = await new ProviderCredentialRepository(scoped).create({
      providerInstanceId: parsed.data.providerInstanceId,
      providerId: parsed.data.providerId,
      scope: parsed.data.scope,
      credentialKind: parsed.data.credentialKind,
      encryptedValue,
      keyVersion: SUPPORTED_CREDENTIAL_KEY_VERSION,
    });
    return envelope(c, credentialResource(row), c.get("requestId"));
  };
  app.post("/api/v1/provider-credentials", async (c) => {
    try {
      return await createCredential(c);
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
  app.post("/api/v1/workspaces/:workspaceId/provider-credentials", async (c) => {
    try {
      return await createCredential(c, routeParam(c, "workspaceId"));
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });

  const updateCredential = async (c: ApiContext, workspaceId?: string) => {
    const parsed = updateProviderCredentialInputSchema.safeParse(await parseJson(c));
    if (!parsed.success)
      throw new ApplicationError("Invalid provider credential input", "invalid_request", 400);
    const resolvedWorkspace = workspaceId
      ? await resolveWorkspace(c, options, workspaceId)
      : await credentialWorkspace(c);
    if (workspaceId && resolvedWorkspace !== workspaceId)
      throw new ApplicationError("Provider credential not found", "not_found", 404);
    const scoped = new ScopedDatabase(options.db.db, {
      workspaceId: workspaceId ?? resolvedWorkspace,
      actorId: c.get("identity").userId,
    });
    const repository = new ProviderCredentialRepository(scoped);
    const credentialId = routeParam(c, "credentialId");
    const current = await repository.getForSecretMutation(credentialId);
    if (current.keyVersion !== SUPPORTED_CREDENTIAL_KEY_VERSION)
      throw new ApplicationError(
        "The provider credential uses an unsupported encryption key version",
        "conflict",
        409,
      );
    if (current.providerInstanceId) {
      const instanceRepository = new ProviderInstanceRepository(scoped);
      const instance = await instanceRepository.getForMutation(current.providerInstanceId);
      const entry = catalogEntry(
        requireCatalog(options),
        instance.module as ProviderModule,
        instance.providerId,
      );
      const isBound = instance.credentialBindings.some(
        (binding) => binding.credentialId === credentialId,
      );
      if (isBound) {
        assertCredentialKind(entry, current.credentialKind);
        const key = requireEncryptionKey(options);
        await instanceRepository.setup(current.providerInstanceId, {
          expectedConfigDigest: instance.configDigest,
          secrets: { [current.credentialKind]: parsed.data.secret },
          declaredSecretNames: entry.requiredSecrets.map((secret) => secret.name),
          buildConfig: (currentConfig, requestedConfig, bindings) =>
            configWithCredentialReferences(
              requireCatalog(options),
              entry,
              requestedConfig === undefined
                ? currentConfig
                : { ...currentConfig, ...requestedConfig },
              bindings,
            ),
          computeConfigDigest: (config, bindings) =>
            computeConfigDigest(requireCatalog(options), entry, config, bindings),
          assertReadyForDefault: (bindings) => assertReadyForDefault(entry, bindings),
          encryptSecret: ({
            value,
            workspaceId: credentialWorkspaceId,
            providerInstanceId,
            secretName,
            revision,
            createdBy,
            userId,
          }) =>
            encryptCredentialEnvelope(value, key, {
              workspaceId: credentialWorkspaceId,
              actorId: createdBy ?? userId ?? c.get("identity").userId,
              providerInstanceId,
              secretName,
              revision,
            }),
        });
        const rotated = await repository.get(credentialId);
        return envelope(c, credentialResource(rotated), c.get("requestId"));
      }
    }
    const key = requireEncryptionKey(options);
    const encryptedValue = encryptCredentialEnvelope(parsed.data.secret, key, {
      workspaceId: current.workspaceId,
      actorId: current.createdBy ?? current.userId ?? c.get("identity").userId,
      providerInstanceId: current.providerInstanceId ?? "",
      secretName: current.credentialKind,
      revision: current.secretRevision + 1,
    });
    const row = await repository.updateSecret(credentialId, {
      encryptedValue,
      keyVersion: SUPPORTED_CREDENTIAL_KEY_VERSION,
    });
    return envelope(c, credentialResource(row), c.get("requestId"));
  };
  app.patch("/api/v1/provider-credentials/:credentialId", async (c) => {
    try {
      return await updateCredential(c);
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
  app.patch("/api/v1/workspaces/:workspaceId/provider-credentials/:credentialId", async (c) => {
    try {
      return await updateCredential(c, routeParam(c, "workspaceId"));
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });

  const deleteCredential = async (c: ApiContext, workspaceId?: string) => {
    const resolvedWorkspace = workspaceId
      ? await resolveWorkspace(c, options, workspaceId)
      : await credentialWorkspace(c);
    if (workspaceId && resolvedWorkspace !== workspaceId)
      throw new ApplicationError("Provider credential not found", "not_found", 404);
    const scoped = new ScopedDatabase(options.db.db, {
      workspaceId: workspaceId ?? resolvedWorkspace,
      actorId: c.get("identity").userId,
    });
    await new ProviderCredentialRepository(scoped).revoke(routeParam(c, "credentialId"));
    return c.body(null, 204);
  };
  app.delete("/api/v1/provider-credentials/:credentialId", async (c) => {
    try {
      return await deleteCredential(c);
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
  app.delete("/api/v1/workspaces/:workspaceId/provider-credentials/:credentialId", async (c) => {
    try {
      return await deleteCredential(c, routeParam(c, "workspaceId"));
    } catch (error) {
      return jsonError(c, routeError(error), c.get("requestId"));
    }
  });
}
