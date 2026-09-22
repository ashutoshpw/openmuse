import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbTransaction, ScopedDatabase } from "./context.js";
import { RepositoryError } from "./repositories.js";
import { providerCredentials, providerInstanceDefaults, providerInstances } from "./schema.js";

export type ProviderInstanceScope = "workspace" | "user";
export type ProviderCredentialScope = "workspace" | "user";

export interface ProviderBinding {
  name: string;
  credentialId: string;
  revision: number;
}

/**
 * Metadata needed to rotate a secret. This projection is deliberately
 * ciphertext-free so callers can construct the AAD for the next revision
 * without being able to accidentally return the encrypted value.
 */
export interface ProviderCredentialMutationMetadata {
  id: string;
  workspaceId: string;
  providerInstanceId: string | null;
  userId: string | null;
  createdBy: string | null;
  provider: string;
  credentialKind: string;
  keyVersion: number;
  secretRevision: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderInstanceSetupInput {
  expectedConfigDigest: string;
  config?: Record<string, unknown>;
  displayName?: string;
  version?: string;
  configVersion?: string;
  secrets: Readonly<Record<string, string>>;
  declaredSecretNames: readonly string[];
  buildConfig: (
    currentConfig: Record<string, unknown>,
    requestedConfig: Record<string, unknown> | undefined,
    bindings: readonly ProviderBinding[],
  ) => Record<string, unknown>;
  computeConfigDigest: (
    config: Record<string, unknown>,
    bindings: readonly ProviderBinding[],
  ) => string;
  assertReadyForDefault?: (bindings: readonly ProviderBinding[]) => void;
  encryptSecret: (input: {
    value: string;
    workspaceId: string;
    actorId: string;
    providerInstanceId: string;
    secretName: string;
    revision: number;
    createdBy: string | null;
    userId: string | null;
  }) => string;
}

function notFound(resource: string): never {
  throw new RepositoryError(`${resource} was not found`, "not_found");
}

function forbidden(message: string): never {
  throw new RepositoryError(message, "forbidden");
}

function invalid(message: string): never {
  throw new RepositoryError(message, "invalid");
}

function requireActorOwnerOrAdmin(
  row: { userId: string | null },
  actorId: string,
  canAdmin: boolean,
): void {
  if (row.userId === actorId || (row.userId === null && canAdmin)) return;
  forbidden("Provider instance administration is required");
}

export class ProviderInstanceRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  private get scope() {
    return this.scoped.scope;
  }

  async list(
    input: {
      module?: string;
      scope?: ProviderInstanceScope;
      includeUnavailable?: boolean;
    } = {},
  ) {
    return this.scoped.run(async (tx) => {
      const rows = await tx
        .select()
        .from(providerInstances)
        .where(
          and(
            eq(providerInstances.workspaceId, this.scope.workspaceId),
            or(isNull(providerInstances.userId), eq(providerInstances.userId, this.scope.actorId)),
            ...(input.module ? [eq(providerInstances.module, input.module)] : []),
            ...(input.scope === "workspace" ? [isNull(providerInstances.userId)] : []),
            ...(input.scope === "user" ? [eq(providerInstances.userId, this.scope.actorId)] : []),
            ...(input.includeUnavailable ? [] : [eq(providerInstances.status, "available")]),
          ),
        )
        .orderBy(desc(providerInstances.updatedAt));
      return rows;
    });
  }

  async get(id: string) {
    return this.scoped.run((tx) => this.getReadable(tx, id));
  }

  async getForMutation(id: string) {
    return this.scoped.run(async (tx) => {
      const row = await this.getReadable(tx, id);
      const canAdmin = await this.canAdmin(tx);
      requireActorOwnerOrAdmin(row, this.scope.actorId, canAdmin);
      return row;
    });
  }

  async create(input: {
    id?: string;
    providerId: string;
    module: string;
    scope: ProviderInstanceScope;
    displayName: string;
    config: Record<string, unknown>;
    credentialBindings: ProviderBinding[];
    version: string;
    configVersion: string;
    configDigest: string;
    metadata: Record<string, unknown>;
    isDefault?: boolean;
  }) {
    if (input.scope !== "workspace" && input.scope !== "user")
      invalid("System provider instances are immutable");
    return this.scoped.run(async (tx) => {
      const canAdmin = await this.canAdmin(tx);
      if (input.scope === "workspace" && !canAdmin)
        forbidden("Workspace provider administration is required");
      const id = input.id ?? randomUUID();
      const [row] = await tx
        .insert(providerInstances)
        .values({
          id,
          workspaceId: this.scope.workspaceId,
          userId: input.scope === "user" ? this.scope.actorId : null,
          providerId: input.providerId,
          module: input.module,
          displayName: input.displayName,
          status: "available",
          config: input.config,
          credentialBindings: input.credentialBindings,
          version: input.version,
          configVersion: input.configVersion,
          configDigest: input.configDigest,
          metadata: input.metadata,
          createdBy: this.scope.actorId,
        })
        .returning();
      if (!row) throw new RepositoryError("Provider instance could not be created", "conflict");
      await assertCredentialBindingsInTransaction(tx, {
        workspaceId: this.scope.workspaceId,
        actorId: this.scope.actorId,
        providerInstanceId: row.id,
        providerId: row.providerId,
        bindings: row.credentialBindings,
      });
      if (input.isDefault) await this.setDefaultInTransaction(tx, row.id, input.scope, canAdmin);
      return row;
    });
  }

  async update(
    id: string,
    input: {
      displayName?: string;
      config?: Record<string, unknown>;
      credentialBindings?: ProviderBinding[];
      enabled?: boolean;
      version?: string;
      configVersion?: string;
      configDigest?: string;
      metadata?: Record<string, unknown>;
      expectedConfigDigest?: string;
      isDefault?: boolean;
    },
  ) {
    return this.scoped.run(async (tx) => {
      const current = await this.getForUpdate(tx, id);
      const canAdmin = await this.canAdmin(tx);
      requireActorOwnerOrAdmin(current, this.scope.actorId, canAdmin);
      if (input.expectedConfigDigest && input.expectedConfigDigest !== current.configDigest)
        throw new RepositoryError("Provider configuration changed concurrently", "conflict");
      const configChanged = input.config !== undefined || input.credentialBindings !== undefined;
      if (configChanged && !input.expectedConfigDigest)
        invalid("expectedConfigDigest is required when provider configuration changes");
      const [row] = await tx
        .update(providerInstances)
        .set({
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.config === undefined ? {} : { config: input.config }),
          ...(input.credentialBindings === undefined
            ? {}
            : { credentialBindings: input.credentialBindings }),
          ...(input.enabled === undefined
            ? {}
            : { status: input.enabled ? "available" : "disabled" }),
          ...(input.version === undefined ? {} : { version: input.version }),
          ...(input.configVersion === undefined ? {} : { configVersion: input.configVersion }),
          ...(input.configDigest === undefined ? {} : { configDigest: input.configDigest }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(providerInstances.id, id),
            eq(providerInstances.workspaceId, this.scope.workspaceId),
          ),
        )
        .returning();
      if (!row) notFound("Provider instance");
      await assertCredentialBindingsInTransaction(tx, {
        workspaceId: this.scope.workspaceId,
        actorId: this.scope.actorId,
        providerInstanceId: row.id,
        providerId: row.providerId,
        bindings: row.credentialBindings,
      });
      if (input.isDefault !== undefined) {
        const scope: ProviderInstanceScope = row.userId === null ? "workspace" : "user";
        if (input.isDefault) await this.setDefaultInTransaction(tx, id, scope, canAdmin);
        else await this.clearDefaultInTransaction(tx, id, scope);
      } else if (input.enabled === false) {
        const scope: ProviderInstanceScope = row.userId === null ? "workspace" : "user";
        await this.clearDefaultInTransaction(tx, id, scope);
      }
      return row;
    });
  }

  /**
   * Apply provider configuration and write-only secret values as one
   * compare-and-swap transaction. The instance row is locked before any
   * credential rows; every validation, encryption, and digest calculation is
   * completed before the first write so failures leave no partial setup.
   */
  async setup(id: string, input: ProviderInstanceSetupInput) {
    const declaredNames = new Set(input.declaredSecretNames);
    for (const name of Object.keys(input.secrets)) {
      if (!declaredNames.has(name))
        invalid(`Provider secret ${name} is not declared by the provider`);
    }

    return this.scoped.run(async (tx) => {
      const current = await this.getForUpdate(tx, id);
      const canAdmin = await this.canAdmin(tx);
      requireActorOwnerOrAdmin(current, this.scope.actorId, canAdmin);
      if (current.configDigest !== input.expectedConfigDigest)
        throw new RepositoryError("Provider configuration changed concurrently", "conflict");

      const credentialOwner =
        current.userId === null
          ? isNull(providerCredentials.userId)
          : eq(providerCredentials.userId, current.userId);
      const credentials = await tx
        .select()
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.workspaceId, this.scope.workspaceId),
            eq(providerCredentials.providerInstanceId, id),
            eq(providerCredentials.provider, current.providerId),
            credentialOwner,
          ),
        )
        .for("update");
      const credentialById = new Map(credentials.map((credential) => [credential.id, credential]));
      const credentialByKind = new Map(
        credentials.map((credential) => [credential.credentialKind, credential]),
      );
      const bindings = current.credentialBindings.map((binding) => ({ ...binding }));
      const bindingNames = new Set<string>();
      const bindingIds = new Set<string>();
      for (const binding of bindings) {
        if (!declaredNames.has(binding.name))
          invalid(`Provider secret ${binding.name} is not declared by the provider`);
        if (bindingNames.has(binding.name) || bindingIds.has(binding.credentialId))
          invalid("Provider credential bindings must be unique");
        bindingNames.add(binding.name);
        bindingIds.add(binding.credentialId);
        if (!credentialById.has(binding.credentialId))
          throw new RepositoryError("Provider credential binding is stale", "conflict");
      }

      type CredentialPlan = {
        id: string;
        name: string;
        previousRevision: number | null;
        revision: number;
        encryptedValue: string;
        isNew: boolean;
      };
      const plans: CredentialPlan[] = [];
      for (const [name, value] of Object.entries(input.secrets)) {
        const currentBinding = bindings.find((binding) => binding.name === name);
        const existing = currentBinding
          ? credentialById.get(currentBinding.credentialId)
          : credentialByKind.get(name);
        if (existing && existing.credentialKind !== name)
          invalid("Provider credential bindings do not match their credential kinds");
        const idForSecret = existing?.id ?? randomUUID();
        const revision = (existing?.secretRevision ?? 0) + 1;
        const encryptedValue = input.encryptSecret({
          value,
          workspaceId: this.scope.workspaceId,
          actorId: this.scope.actorId,
          providerInstanceId: id,
          secretName: name,
          revision,
          createdBy: existing?.createdBy ?? this.scope.actorId,
          userId: existing?.userId ?? current.userId,
        });
        plans.push({
          id: idForSecret,
          name,
          previousRevision: existing?.secretRevision ?? null,
          revision,
          encryptedValue,
          isNew: existing === undefined,
        });
        const nextBinding = { name, credentialId: idForSecret, revision };
        const bindingIndex = bindings.findIndex((binding) => binding.name === name);
        if (bindingIndex === -1) bindings.push(nextBinding);
        else bindings[bindingIndex] = nextBinding;
      }

      const config = input.buildConfig(current.config, input.config, bindings);
      const configDigest = input.computeConfigDigest(config, bindings);
      const [defaultRow] = await tx
        .select({ id: providerInstanceDefaults.id })
        .from(providerInstanceDefaults)
        .where(
          and(
            eq(providerInstanceDefaults.providerInstanceId, id),
            eq(providerInstanceDefaults.workspaceId, this.scope.workspaceId),
            current.userId === null
              ? isNull(providerInstanceDefaults.userId)
              : eq(providerInstanceDefaults.userId, current.userId),
          ),
        )
        .limit(1);
      if (defaultRow) {
        for (const binding of bindings) {
          const credential = credentialById.get(binding.credentialId);
          const plan = plans.find((item) => item.id === binding.credentialId);
          const active = plan ? true : credential?.status === "active";
          const revision = plan?.revision ?? credential?.secretRevision;
          if ((!plan && !credential) || !active || revision !== binding.revision)
            throw new RepositoryError(
              "Provider credentials must be configured before selecting a default provider",
              "conflict",
            );
        }
        input.assertReadyForDefault?.(bindings);
      }

      // All checks above, including encryption and final digest derivation,
      // happen before mutating either table.
      for (const plan of plans) {
        if (plan.isNew) {
          await tx.insert(providerCredentials).values({
            id: plan.id,
            workspaceId: this.scope.workspaceId,
            providerInstanceId: id,
            userId: current.userId,
            createdBy: this.scope.actorId,
            provider: current.providerId,
            credentialKind: plan.name,
            encryptedValue: plan.encryptedValue,
            keyVersion: 1,
            secretRevision: plan.revision,
            status: "active",
          });
        } else {
          const [updated] = await tx
            .update(providerCredentials)
            .set({
              encryptedValue: plan.encryptedValue,
              secretRevision: plan.revision,
              status: "active",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(providerCredentials.id, plan.id),
                eq(providerCredentials.workspaceId, this.scope.workspaceId),
                plan.previousRevision === null
                  ? sql`false`
                  : eq(providerCredentials.secretRevision, plan.previousRevision),
              ),
            )
            .returning({ id: providerCredentials.id });
          if (!updated)
            throw new RepositoryError("Provider credential was changed concurrently", "conflict");
        }
      }

      const [row] = await tx
        .update(providerInstances)
        .set({
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          config,
          credentialBindings: bindings,
          configDigest,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(providerInstances.id, id),
            eq(providerInstances.workspaceId, this.scope.workspaceId),
            eq(providerInstances.configDigest, input.expectedConfigDigest),
          ),
        )
        .returning();
      if (!row)
        throw new RepositoryError("Provider configuration changed concurrently", "conflict");
      return row;
    });
  }

  async revoke(id: string): Promise<void> {
    await this.scoped.run(async (tx) => {
      const current = await this.getReadable(tx, id);
      const canAdmin = await this.canAdmin(tx);
      requireActorOwnerOrAdmin(current, this.scope.actorId, canAdmin);
      await tx
        .update(providerInstances)
        .set({ status: "disabled", updatedAt: new Date() })
        .where(
          and(
            eq(providerInstances.id, id),
            eq(providerInstances.workspaceId, this.scope.workspaceId),
          ),
        );
      await tx
        .delete(providerInstanceDefaults)
        .where(eq(providerInstanceDefaults.providerInstanceId, id));
    });
  }

  async resolveDefault(module: string): Promise<typeof providerInstances.$inferSelect | null> {
    return this.scoped.run(async (tx) => {
      const [personal] = await tx
        .select({ instance: providerInstances })
        .from(providerInstanceDefaults)
        .innerJoin(
          providerInstances,
          eq(providerInstances.id, providerInstanceDefaults.providerInstanceId),
        )
        .where(
          and(
            eq(providerInstanceDefaults.workspaceId, this.scope.workspaceId),
            eq(providerInstanceDefaults.userId, this.scope.actorId),
            eq(providerInstanceDefaults.module, module),
            eq(providerInstances.status, "available"),
          ),
        )
        .limit(1);
      if (personal?.instance) return personal.instance;
      const [workspace] = await tx
        .select({ instance: providerInstances })
        .from(providerInstanceDefaults)
        .innerJoin(
          providerInstances,
          eq(providerInstances.id, providerInstanceDefaults.providerInstanceId),
        )
        .where(
          and(
            eq(providerInstanceDefaults.workspaceId, this.scope.workspaceId),
            isNull(providerInstanceDefaults.userId),
            eq(providerInstanceDefaults.module, module),
            eq(providerInstances.status, "available"),
          ),
        )
        .limit(1);
      return workspace?.instance ?? null;
    });
  }

  async isDefault(id: string): Promise<boolean> {
    return this.scoped.run(async (tx) => {
      const rows = await tx
        .select({ id: providerInstanceDefaults.id })
        .from(providerInstanceDefaults)
        .where(
          and(
            eq(providerInstanceDefaults.providerInstanceId, id),
            eq(providerInstanceDefaults.workspaceId, this.scope.workspaceId),
            or(
              isNull(providerInstanceDefaults.userId),
              eq(providerInstanceDefaults.userId, this.scope.actorId),
            ),
          ),
        )
        .limit(1);
      return rows.length === 1;
    });
  }

  private async getReadable(tx: DbTransaction, id: string) {
    const [row] = await tx
      .select()
      .from(providerInstances)
      .where(
        and(
          eq(providerInstances.id, id),
          eq(providerInstances.workspaceId, this.scope.workspaceId),
          or(isNull(providerInstances.userId), eq(providerInstances.userId, this.scope.actorId)),
        ),
      )
      .limit(1);
    return row ?? notFound("Provider instance");
  }

  private async getForUpdate(tx: DbTransaction, id: string) {
    const [row] = await tx
      .select()
      .from(providerInstances)
      .where(
        and(
          eq(providerInstances.id, id),
          eq(providerInstances.workspaceId, this.scope.workspaceId),
          or(isNull(providerInstances.userId), eq(providerInstances.userId, this.scope.actorId)),
        ),
      )
      .for("update")
      .limit(1);
    return row ?? notFound("Provider instance");
  }

  private async canAdmin(tx: DbTransaction): Promise<boolean> {
    const rows = await tx.execute<{ role: string; status: string }>(
      sql`select role, status from workspace_members where workspace_id = ${this.scope.workspaceId} and user_id = ${this.scope.actorId} limit 1`,
    );
    const member = rows[0];
    return member?.status === "active" && (member.role === "owner" || member.role === "admin");
  }

  private async setDefaultInTransaction(
    tx: DbTransaction,
    id: string,
    scope: ProviderInstanceScope,
    canAdmin: boolean,
  ): Promise<void> {
    const instance = await this.getReadable(tx, id);
    if (instance.status !== "available")
      throw new RepositoryError(
        "Only an available provider instance can be selected as the default",
        "conflict",
      );
    if (scope === "workspace" && !canAdmin)
      forbidden("Workspace provider defaults require administrator access");
    if (scope === "user" && instance.userId !== this.scope.actorId)
      forbidden("Personal provider defaults belong to their owner");
    const userId = scope === "user" ? this.scope.actorId : null;
    await tx
      .delete(providerInstanceDefaults)
      .where(
        and(
          eq(providerInstanceDefaults.workspaceId, this.scope.workspaceId),
          eq(providerInstanceDefaults.module, instance.module),
          userId === null
            ? isNull(providerInstanceDefaults.userId)
            : eq(providerInstanceDefaults.userId, userId),
        ),
      );
    await tx.insert(providerInstanceDefaults).values({
      id: randomUUID(),
      workspaceId: this.scope.workspaceId,
      userId,
      module: instance.module,
      providerInstanceId: id,
      createdBy: this.scope.actorId,
    });
  }

  private async clearDefaultInTransaction(
    tx: DbTransaction,
    id: string,
    scope: ProviderInstanceScope,
  ): Promise<void> {
    const userId = scope === "user" ? this.scope.actorId : null;
    await tx
      .delete(providerInstanceDefaults)
      .where(
        and(
          eq(providerInstanceDefaults.providerInstanceId, id),
          eq(providerInstanceDefaults.workspaceId, this.scope.workspaceId),
          userId === null
            ? isNull(providerInstanceDefaults.userId)
            : eq(providerInstanceDefaults.userId, userId),
        ),
      );
  }
}

export class ProviderCredentialRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  private get scope() {
    return this.scoped.scope;
  }

  async list(
    input: {
      providerId?: string;
      providerInstanceId?: string;
      scope?: ProviderCredentialScope;
      status?: "active" | "revoked";
    } = {},
  ) {
    return this.scoped.run((tx) =>
      tx
        .select({
          id: providerCredentials.id,
          workspaceId: providerCredentials.workspaceId,
          providerInstanceId: providerCredentials.providerInstanceId,
          userId: providerCredentials.userId,
          provider: providerCredentials.provider,
          credentialKind: providerCredentials.credentialKind,
          keyVersion: providerCredentials.keyVersion,
          secretRevision: providerCredentials.secretRevision,
          status: providerCredentials.status,
          createdAt: providerCredentials.createdAt,
          updatedAt: providerCredentials.updatedAt,
        })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.workspaceId, this.scope.workspaceId),
            or(
              isNull(providerCredentials.userId),
              eq(providerCredentials.userId, this.scope.actorId),
            ),
            ...(input.providerId ? [eq(providerCredentials.provider, input.providerId)] : []),
            ...(input.providerInstanceId
              ? [eq(providerCredentials.providerInstanceId, input.providerInstanceId)]
              : []),
            ...(input.scope === "workspace" ? [isNull(providerCredentials.userId)] : []),
            ...(input.scope === "user" ? [eq(providerCredentials.userId, this.scope.actorId)] : []),
            ...(input.status ? [eq(providerCredentials.status, input.status)] : []),
          ),
        )
        .orderBy(desc(providerCredentials.updatedAt)),
    );
  }

  async get(id: string) {
    return this.scoped.run(async (tx) => {
      const [row] = await tx
        .select({
          id: providerCredentials.id,
          workspaceId: providerCredentials.workspaceId,
          providerInstanceId: providerCredentials.providerInstanceId,
          userId: providerCredentials.userId,
          provider: providerCredentials.provider,
          credentialKind: providerCredentials.credentialKind,
          keyVersion: providerCredentials.keyVersion,
          secretRevision: providerCredentials.secretRevision,
          status: providerCredentials.status,
          createdAt: providerCredentials.createdAt,
          updatedAt: providerCredentials.updatedAt,
        })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.id, id),
            eq(providerCredentials.workspaceId, this.scope.workspaceId),
            or(
              isNull(providerCredentials.userId),
              eq(providerCredentials.userId, this.scope.actorId),
            ),
          ),
        )
        .limit(1);
      return row ?? notFound("Provider credential");
    });
  }

  async create(input: {
    id?: string;
    providerInstanceId: string;
    providerId: string;
    scope: ProviderCredentialScope;
    credentialKind: string;
    encryptedValue: string;
    keyVersion: number;
  }) {
    return this.scoped.run(async (tx) => {
      const instance = await this.instanceForWrite(tx, input.providerInstanceId);
      if (instance.providerId !== input.providerId)
        invalid("Credential provider does not match instance");
      const canAdmin = await this.canAdmin(tx);
      if (input.scope === "workspace" && !canAdmin)
        forbidden("Workspace credential administration is required");
      if (input.scope === "user" && instance.userId !== this.scope.actorId)
        forbidden("Personal credentials require a personal provider instance");
      if (input.scope === "workspace" && instance.userId !== null)
        invalid("Workspace credentials require a workspace provider instance");
      if (input.scope === "user" && instance.userId === null)
        invalid("Personal credentials require a personal provider instance");
      const [row] = await tx
        .insert(providerCredentials)
        .values({
          id: input.id ?? randomUUID(),
          workspaceId: this.scope.workspaceId,
          providerInstanceId: input.providerInstanceId,
          userId: input.scope === "user" ? this.scope.actorId : null,
          createdBy: this.scope.actorId,
          provider: input.providerId,
          credentialKind: input.credentialKind,
          encryptedValue: input.encryptedValue,
          keyVersion: input.keyVersion,
          secretRevision: 1,
          status: "active",
        })
        .returning({ id: providerCredentials.id });
      if (!row) throw new RepositoryError("Provider credential could not be created", "conflict");
      return this.getMetadataInTransaction(tx, row.id);
    });
  }

  /**
   * Return only the metadata required to rotate a credential. Authorization
   * is checked here as well as in updateSecret so the API cannot use this as
   * an oracle for another user's credential.
   */
  async getForSecretMutation(id: string): Promise<ProviderCredentialMutationMetadata> {
    return this.scoped.run(async (tx) => {
      const current = await this.getInTransaction(tx, id);
      const canAdmin = await this.canAdmin(tx);
      if (current.userId === null ? !canAdmin : current.userId !== this.scope.actorId)
        forbidden("Provider credential administration is required");
      return toCredentialMutationMetadata(current);
    });
  }

  async updateSecret(id: string, input: { encryptedValue: string; keyVersion: number }) {
    return this.scoped.run(async (tx) => {
      const current = await this.getInTransaction(tx, id);
      const canAdmin = await this.canAdmin(tx);
      if (current.userId === null ? !canAdmin : current.userId !== this.scope.actorId)
        forbidden("Provider credential administration is required");
      const instance = await lockCredentialInstance(
        tx,
        this.scope.workspaceId,
        current.providerInstanceId,
      );
      if (instance?.credentialBindings.some((binding) => binding.credentialId === id))
        throw new RepositoryError(
          "Bound provider credentials must be rotated through provider instance setup",
          "conflict",
        );
      const [updated] = await tx
        .update(providerCredentials)
        .set({
          encryptedValue: input.encryptedValue,
          keyVersion: input.keyVersion,
          secretRevision: current.secretRevision + 1,
          status: "active",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(providerCredentials.id, id),
            eq(providerCredentials.workspaceId, this.scope.workspaceId),
            eq(providerCredentials.secretRevision, current.secretRevision),
          ),
        )
        .returning({ id: providerCredentials.id });
      if (!updated)
        throw new RepositoryError("Provider credential was changed concurrently", "conflict");
      return this.getMetadataInTransaction(tx, id);
    });
  }

  async revoke(id: string): Promise<void> {
    await this.scoped.run(async (tx) => {
      const current = await this.getInTransaction(tx, id);
      const canAdmin = await this.canAdmin(tx);
      if (current.userId === null ? !canAdmin : current.userId !== this.scope.actorId)
        forbidden("Provider credential administration is required");
      await lockCredentialInstance(tx, this.scope.workspaceId, current.providerInstanceId);
      await tx
        .update(providerCredentials)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(
          and(
            eq(providerCredentials.id, id),
            eq(providerCredentials.workspaceId, this.scope.workspaceId),
          ),
        );
      if (current.providerInstanceId)
        await tx
          .delete(providerInstanceDefaults)
          .where(eq(providerInstanceDefaults.providerInstanceId, current.providerInstanceId));
    });
  }

  private async instanceForWrite(tx: DbTransaction, id: string) {
    const [instance] = await tx
      .select()
      .from(providerInstances)
      .where(
        and(
          eq(providerInstances.id, id),
          eq(providerInstances.workspaceId, this.scope.workspaceId),
          or(isNull(providerInstances.userId), eq(providerInstances.userId, this.scope.actorId)),
        ),
      )
      .for("update")
      .limit(1);
    if (!instance) notFound("Provider instance");
    const canAdmin = await this.canAdmin(tx);
    requireActorOwnerOrAdmin(instance, this.scope.actorId, canAdmin);
    return instance;
  }

  private async getInTransaction(tx: DbTransaction, id: string) {
    const [row] = await tx
      .select()
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.id, id),
          eq(providerCredentials.workspaceId, this.scope.workspaceId),
          or(
            isNull(providerCredentials.userId),
            eq(providerCredentials.userId, this.scope.actorId),
          ),
        ),
      )
      .limit(1);
    return row ?? notFound("Provider credential");
  }

  private async getMetadataInTransaction(
    tx: DbTransaction,
    id: string,
  ): Promise<ProviderCredentialMutationMetadata> {
    return toCredentialMutationMetadata(await this.getInTransaction(tx, id));
  }

  private async canAdmin(tx: DbTransaction): Promise<boolean> {
    const rows = await tx.execute<{ role: string; status: string }>(
      sql`select role, status from workspace_members where workspace_id = ${this.scope.workspaceId} and user_id = ${this.scope.actorId} limit 1`,
    );
    const member = rows[0];
    return member?.status === "active" && (member.role === "owner" || member.role === "admin");
  }
}

function toCredentialMutationMetadata(
  row: typeof providerCredentials.$inferSelect,
): ProviderCredentialMutationMetadata {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    providerInstanceId: row.providerInstanceId,
    userId: row.userId,
    createdBy: row.createdBy,
    provider: row.provider,
    credentialKind: row.credentialKind,
    keyVersion: row.keyVersion,
    secretRevision: row.secretRevision,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function assertCredentialBindingsInTransaction(
  tx: DbTransaction,
  input: {
    workspaceId: string;
    actorId: string;
    providerInstanceId: string;
    providerId: string;
    bindings: readonly ProviderBinding[];
  },
): Promise<void> {
  if (input.bindings.length === 0) return;
  const ids = input.bindings.map((binding) => binding.credentialId);
  const names = input.bindings.map((binding) => binding.name);
  if (new Set(ids).size !== ids.length || new Set(names).size !== names.length)
    invalid("Provider credential names must be unique");
  const rows = await tx
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.workspaceId, input.workspaceId),
        eq(providerCredentials.providerInstanceId, input.providerInstanceId),
        eq(providerCredentials.provider, input.providerId),
        or(isNull(providerCredentials.userId), eq(providerCredentials.userId, input.actorId)),
        inArray(providerCredentials.id, ids),
      ),
    )
    .for("update");
  if (rows.length !== input.bindings.length)
    invalid("Provider credential bindings do not match their credential kinds");
  for (const binding of input.bindings) {
    const row = rows.find((candidate) => candidate.id === binding.credentialId);
    if (!row || row.credentialKind !== binding.name)
      invalid("Provider credential bindings do not match their credential kinds");
    if (row.status !== "active" || row.secretRevision !== binding.revision)
      throw new RepositoryError(
        "Provider credential changed while the provider was being configured",
        "conflict",
      );
  }
}

/**
 * Provider writers use one lock order: instance, then credential. Default
 * selection locks the credential after the instance update; revoke/rotation
 * takes the same instance lock before changing the credential and deleting
 * defaults. This prevents a revoked credential from racing a default write.
 */
async function lockCredentialInstance(
  tx: DbTransaction,
  workspaceId: string,
  providerInstanceId: string | null,
) {
  if (!providerInstanceId) return undefined;
  const [instance] = await tx
    .select()
    .from(providerInstances)
    .where(
      and(
        eq(providerInstances.id, providerInstanceId),
        eq(providerInstances.workspaceId, workspaceId),
      ),
    )
    .for("update")
    .limit(1);
  return instance;
}
