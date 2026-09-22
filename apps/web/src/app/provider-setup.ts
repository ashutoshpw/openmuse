import type { OpenMuseClient } from "@openmuse/client";
import type { ProviderInstance } from "@openmuse/contracts";

type ProviderSetupClient = Pick<
  OpenMuseClient,
  | "createProviderCredential"
  | "createProviderInstance"
  | "listProviderCredentials"
  | "updateProviderCredential"
  | "updateProviderInstance"
>;

export type ProviderSecretValues = Readonly<Record<string, string>>;

export function providerInstanceScope(provider: ProviderInstance): "workspace" | "user" {
  return provider.scope === "user" ? "user" : "workspace";
}

export function providerCredentialScope(instance: ProviderInstance): "workspace" | "user" {
  return instance.scope === "user" ? "user" : "workspace";
}

/**
 * Persist a provider configuration without ever putting a plaintext secret
 * into the provider-instance config. The final PATCH is the CAS boundary for
 * the instance and is intentionally never retried by this helper.
 */
export async function saveProviderSetup(input: {
  api: ProviderSetupClient;
  provider: ProviderInstance;
  displayName?: string;
  config: Record<string, unknown>;
  secrets: ProviderSecretValues;
}): Promise<ProviderInstance> {
  const { api, provider } = input;
  const target =
    provider.scope === "system"
      ? await api.createProviderInstance({
          providerId: provider.providerId,
          module: provider.module,
          scope: providerInstanceScope(provider),
          ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
          config: input.config,
          credentialBindings: [],
        })
      : provider;
  const scope = providerCredentialScope(target);
  const credentials = await api.listProviderCredentials({
    providerId: target.providerId,
    providerInstanceId: target.id,
    scope,
    status: "active",
    limit: 100,
  });
  const activeByName = new Map(
    credentials.items.map((credential) => [credential.credentialKind, credential]),
  );

  for (const secret of target.requiredSecrets) {
    const value = input.secrets[secret.name]?.trim();
    if (!value) continue;
    const current = activeByName.get(secret.name);
    const saved = current
      ? await api.updateProviderCredential(current.id, { secret: value })
      : await api.createProviderCredential({
          providerId: target.providerId,
          providerInstanceId: target.id,
          credentialKind: secret.name,
          scope,
          secret: value,
        });
    activeByName.set(secret.name, saved);
  }

  const credentialBindings = target.requiredSecrets.flatMap((secret) => {
    const credential = activeByName.get(secret.name);
    return credential?.status === "active"
      ? [{ name: secret.name, credentialId: credential.id }]
      : [];
  });

  return api.updateProviderInstance(target.id, {
    ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
    config: input.config,
    credentialBindings,
    expectedConfigDigest: target.configDigest,
  });
}
