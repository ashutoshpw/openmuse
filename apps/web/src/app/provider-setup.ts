import type { OpenMuseClient } from "@openmuse/client";
import type { ProviderInstance } from "@openmuse/contracts";

type ProviderSetupClient = Pick<OpenMuseClient, "createProviderInstance" | "setupProviderInstance">;

export type ProviderSecretValues = Readonly<Record<string, string>>;

export function providerInstanceScope(provider: ProviderInstance): "workspace" | "user" {
  return provider.scope === "user" ? "user" : "workspace";
}

export function providerCredentialScope(instance: ProviderInstance): "workspace" | "user" {
  return instance.scope === "user" ? "user" : "workspace";
}

/**
 * Persist a provider configuration and write-only secrets in one atomic setup
 * request. Blank secret fields are omitted so the server preserves any
 * existing credential values. The compare-and-swap request is intentionally
 * never retried by this helper.
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
  const secrets = Object.fromEntries(
    Object.entries(input.secrets).flatMap(([name, value]) => {
      const trimmed = value.trim();
      return trimmed ? [[name, trimmed]] : [];
    }),
  );
  return api.setupProviderInstance(target.id, {
    ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
    expectedConfigDigest: target.configDigest,
    config: input.config,
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  });
}
