import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { ChatProviderSnapshot } from "./chat-repository.js";
import type { DbTransaction } from "./context.js";
import { RepositoryError } from "./repository-error.js";
import { providerCredentials, providerInstances } from "./schema.js";

/**
 * Validate a provider snapshot while the caller's write transaction is still
 * open. The instance and credential rows are locked so a revoke/rotation
 * cannot race the run creation and leave a run pinned to an unverified state.
 */
export async function assertProviderSnapshotInTransaction(
  tx: DbTransaction,
  workspaceId: string,
  actorId: string,
  provider: ChatProviderSnapshot,
): Promise<void> {
  if (provider.module !== "model")
    throw new RepositoryError("The selected provider is not a model", "invalid");
  const [instance] = await tx
    .select()
    .from(providerInstances)
    .where(
      and(
        eq(providerInstances.id, provider.providerInstanceId),
        eq(providerInstances.workspaceId, workspaceId),
        eq(providerInstances.providerId, provider.providerId),
        eq(providerInstances.module, "model"),
        eq(providerInstances.status, "available"),
        or(isNull(providerInstances.userId), eq(providerInstances.userId, actorId)),
      ),
    )
    .for("update")
    .limit(1);
  if (!instance)
    throw new RepositoryError("The selected model provider is unavailable", "conflict");
  if (
    instance.version !== provider.version ||
    instance.configVersion !== provider.configVersion ||
    instance.configDigest !== provider.configDigest ||
    canonicalize(instance.config) !== canonicalize(provider.config) ||
    canonicalize(instance.credentialBindings) !== canonicalize(provider.credentialBindings)
  )
    throw new RepositoryError("The selected provider snapshot is stale", "conflict");

  const bindings = provider.credentialBindings;
  const ids = bindings.map((binding) => binding.credentialId);
  if (new Set(ids).size !== ids.length)
    throw new RepositoryError("Provider credential bindings are invalid", "invalid");
  if (ids.length === 0) return;
  const credentials = await tx
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.workspaceId, workspaceId),
        eq(providerCredentials.providerInstanceId, provider.providerInstanceId),
        eq(providerCredentials.provider, provider.providerId),
        eq(providerCredentials.status, "active"),
        or(isNull(providerCredentials.userId), eq(providerCredentials.userId, actorId)),
        inArray(providerCredentials.id, ids),
      ),
    )
    .for("update");
  if (
    credentials.length !== bindings.length ||
    bindings.some(
      (binding) =>
        !credentials.some(
          (credential) =>
            credential.id === binding.credentialId &&
            credential.secretRevision === binding.revision &&
            credential.credentialKind === binding.name,
        ),
    )
  )
    throw new RepositoryError(
      "The selected provider credential is stale or mismatched",
      "conflict",
    );
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value as object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
