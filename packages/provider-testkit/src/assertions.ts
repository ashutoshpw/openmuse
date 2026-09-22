import type { ProviderRegistration } from "@openmuse/provider-contracts";

export function assertProviderRegistration<Config, Instance>(registration: ProviderRegistration<Config, Instance>): void {
  if (!registration.providerId.trim()) throw new Error("Provider registration requires a providerId");
  if (!registration.metadata.version.trim()) throw new Error("Provider registration requires a version");
  if (!registration.metadata.configVersion.trim()) throw new Error("Provider registration requires a config version");
  if (!registration.metadata.buildDigest.trim()) throw new Error("Provider registration requires a build digest");
  if (registration.metadata.capabilities.length === 0) throw new Error("Provider registration requires capabilities");
  if (registration.metadata.capabilities.some((capability) => !capability.key.trim())) {
    throw new Error("Provider capabilities require non-empty keys");
  }
}
