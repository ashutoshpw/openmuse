import type { ProviderModule } from "@openmuse/contracts";
import {
  normalizeProviderError,
  type ProviderConfigDefinition,
  type ProviderCreateContext,
  type ProviderMetadata,
  type ProviderRegistration,
} from "@openmuse/provider-contracts";
import { CoreError, redact } from "./errors.js";

type AnyRegistration = ProviderRegistration<unknown, unknown>;

export interface ProviderRegistrationView {
  module: ProviderModule;
  providerId: string;
  metadata: ProviderMetadata;
  configVersion: string;
  capabilities: readonly string[];
}

export interface ProviderScopeContext extends Omit<ProviderCreateContext, "scopeId" | "signal"> {
  scopeId?: string;
  signal?: AbortSignal;
}

export interface ProviderScope {
  readonly id: string;
  resolve<Instance>(
    providerInstanceId: string,
    module: ProviderModule,
    providerId: string,
    config: unknown,
    options?: { configDigest?: string },
  ): Promise<Instance>;
  close(reason?: string): Promise<void>;
}

function keyFor(module: ProviderModule, providerId: string): string {
  return `${module}:${providerId}`;
}

function stableConfig(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableConfig).join(",")}]`;
  return `{${Object.keys(value as object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableConfig((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function parseConfig<Config>(definition: ProviderConfigDefinition<Config>, input: unknown): Config {
  const withDefaults = definition.defaults ? Object.assign(definition.defaults(), input) : input;
  const parsed = definition.schema.safeParse(withDefaults);
  if (!parsed.success) {
    throw new CoreError("invalid_provider_config", "The provider configuration is invalid.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    });
  }
  return parsed.data;
}

export class ProviderRegistry {
  private readonly registrations = new Map<string, AnyRegistration>();

  constructor(
    private readonly options: {
      allowRegistration?: (registration: ProviderRegistrationView) => boolean;
    } = {},
  ) {}

  register<Config, Instance>(registration: ProviderRegistration<Config, Instance>): void {
    const key = keyFor(registration.module, registration.providerId);
    if (
      registration.metadata.providerId !== registration.providerId ||
      registration.metadata.configVersion !== registration.config.version
    ) {
      throw new CoreError(
        "provider_metadata_mismatch",
        "Provider metadata does not match its registration.",
        {
          module: registration.module,
          providerId: registration.providerId,
        },
      );
    }
    const view: ProviderRegistrationView = {
      module: registration.module,
      providerId: registration.providerId,
      metadata: registration.metadata,
      configVersion: registration.config.version,
      capabilities: registration.metadata.capabilities.map((capability) => capability.key),
    };
    if (this.options.allowRegistration && !this.options.allowRegistration(view)) {
      throw new CoreError(
        "provider_not_allowlisted",
        "This provider is not allowlisted for this runtime.",
        {
          module: registration.module,
          providerId: registration.providerId,
        },
      );
    }
    if (this.registrations.has(key)) {
      throw new CoreError(
        "duplicate_provider",
        "A provider with this module and ID is already registered.",
        {
          module: registration.module,
          providerId: registration.providerId,
        },
      );
    }
    this.registrations.set(key, registration as AnyRegistration);
  }

  unregister(module: ProviderModule, providerId: string): boolean {
    return this.registrations.delete(keyFor(module, providerId));
  }

  get(module: ProviderModule, providerId: string): ProviderRegistrationView {
    const registration = this.registrations.get(keyFor(module, providerId));
    if (!registration) {
      throw new CoreError("provider_unavailable", "The selected provider is unavailable.", {
        module,
        providerId,
      });
    }
    return {
      module: registration.module,
      providerId: registration.providerId,
      metadata: registration.metadata,
      configVersion: registration.config.version,
      capabilities: registration.metadata.capabilities.map((capability) => capability.key),
    };
  }

  /**
   * Parse provider configuration without constructing a provider client.
   * Server-side catalogues use this at the API boundary; the core registry
   * remains vendor-neutral and never decides which providers are trusted.
   */
  normalizeConfig(module: ProviderModule, providerId: string, input: unknown): unknown {
    const registration = this.registrations.get(keyFor(module, providerId));
    if (!registration)
      throw new CoreError("provider_unavailable", "The selected provider is unavailable.", {
        module,
        providerId,
      });
    return parseConfig(registration.config, input);
  }

  list(module?: ProviderModule): ProviderRegistrationView[] {
    return [...this.registrations.values()]
      .filter((registration) => module === undefined || registration.module === module)
      .map((registration) => this.get(registration.module, registration.providerId));
  }

  assertCapability(module: ProviderModule, providerId: string, capability: string): void {
    const registration = this.registrations.get(keyFor(module, providerId));
    if (!registration)
      throw new CoreError("provider_unavailable", "The selected provider is unavailable.");
    if (!registration.metadata.capabilities.some((item) => item.key === capability)) {
      throw new CoreError(
        "provider_capability_missing",
        "The selected provider does not support this capability.",
        {
          module,
          providerId,
          capability,
        },
      );
    }
  }

  createScope(context: ProviderScopeContext = {}): ProviderScope {
    const scopeId = context.scopeId ?? `scope-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const scopeSignal = context.signal ?? new AbortController().signal;
    const instances = new Map<string, Promise<unknown>>();
    const instanceDefinitions = new Map<
      string,
      { module: ProviderModule; providerId: string; configDigest: string }
    >();
    let closed = false;

    return {
      id: scopeId,
      resolve: async <Instance>(
        providerInstanceId: string,
        module: ProviderModule,
        providerId: string,
        rawConfig: unknown,
        options: { configDigest?: string } = {},
      ) => {
        if (closed) throw new CoreError("scope_closed", "The provider scope is closed.");
        if (!providerInstanceId.trim())
          throw new CoreError("invalid_provider_instance", "A provider instance ID is required.");
        const key = providerInstanceId;
        const configDigest = options.configDigest ?? stableConfig(rawConfig);
        const priorDefinition = instanceDefinitions.get(key);
        if (
          priorDefinition &&
          (priorDefinition.module !== module ||
            priorDefinition.providerId !== providerId ||
            priorDefinition.configDigest !== configDigest)
        ) {
          throw new CoreError(
            "provider_instance_conflict",
            "A provider instance ID cannot be reused with different provider configuration.",
            {
              providerInstanceId,
              module,
              providerId,
            },
          );
        }
        const existing = instances.get(key);
        if (existing) return (await existing) as Instance;
        const registration = this.registrations.get(keyFor(module, providerId));
        if (!registration)
          throw new CoreError("provider_unavailable", "The selected provider is unavailable.", {
            module,
            providerId,
          });
        instanceDefinitions.set(key, { module, providerId, configDigest });
        const parsed = parseConfig(registration.config, rawConfig);
        const createContext: ProviderCreateContext = { ...context, signal: scopeSignal, scopeId };
        const instancePromise = Promise.resolve()
          .then(() => registration.create(parsed, createContext))
          .catch((error) => {
            instances.delete(key);
            instanceDefinitions.delete(key);
            throw normalizeProviderError(error, { module, providerId, operation: "create" });
          });
        instances.set(key, instancePromise);
        return (await instancePromise) as Instance;
      },
      close: async (reason?: string) => {
        if (closed) return;
        closed = true;
        const resolved = await Promise.allSettled(instances.values());
        const errors: unknown[] = [];
        for (const item of resolved) {
          if (item.status === "rejected") errors.push(item.reason);
          else if (item.value && typeof item.value === "object" && "close" in item.value) {
            try {
              await (item.value as { close(reason?: string): Promise<void> }).close(reason);
            } catch (error) {
              errors.push(error);
            }
          }
        }
        if (errors.length > 0) {
          throw new CoreError(
            "scope_close_failed",
            "One or more provider resources failed to close.",
            {
              errors: errors.map((error) => redact(error)),
            },
          );
        }
      },
    };
  }
}
