import type {
  ConnectorClient,
  ConnectorConfig,
  ConnectorConnectionState,
  ConnectorDriver,
  ConnectorOperationRequest,
  ModelClient,
  ModelConfig,
  ModelDriver,
  ModelEvent,
  ModelGenerateRequest,
  NotificationClient,
  NotificationConfig,
  NotificationDriver,
  NotificationReceipt,
  NotificationSendRequest,
  ProviderCapability,
  ProviderCreateContext,
  ProviderMetadata,
  ProviderOperationContext,
  JsonValue,
  ProviderConfigDefinition,
} from "@openmuse/provider-contracts";

function schemaWithDefaults<T extends object>(defaults: T): ProviderConfigDefinition<T>["schema"] {
  const parse = (input: unknown): T =>
    ({ ...defaults, ...(input && typeof input === "object" ? input : {}) }) as T;
  return {
    parse,
    safeParse: (input: unknown) => ({ success: true as const, data: parse(input) }),
  } as ProviderConfigDefinition<T>["schema"];
}

export const fakeModelConfigSchema = schemaWithDefaults<ModelConfig>({
  defaultModel: "fake-model",
});

function metadata(
  module: "model" | "connector" | "notification",
  providerId: string,
  capabilities: readonly string[],
): ProviderMetadata {
  return {
    providerId,
    displayName: `Fake ${module}`,
    version: "test",
    configVersion: "1",
    buildDigest: `sha256:test-${providerId}`,
    capabilities: capabilities.map((key): ProviderCapability => ({ key })),
    requiredSecrets: [],
    trusted: true,
  };
}

export interface FakeModelOptions {
  events?: readonly ModelEvent[];
}

export function createFakeModelDriver(options: FakeModelOptions = {}): ModelDriver {
  const events = options.events ?? [
    { type: "text_delta", text: "deterministic response" },
    { type: "usage", inputTokens: 3, outputTokens: 2 },
    { type: "completed", finishReason: "stop" },
  ];
  return {
    module: "model",
    providerId: "fake-model",
    metadata: metadata("model", "fake-model", ["generate", "stream"]),
    config: { version: "1", schema: fakeModelConfigSchema },
    async create(_config: ModelConfig, _context: ProviderCreateContext): Promise<ModelClient> {
      return {
        async *generate(
          _request: ModelGenerateRequest,
          _context: ProviderOperationContext,
        ): AsyncIterable<ModelEvent> {
          for (const event of events) yield structuredClone(event);
        },
        async close() {
          // Deterministic fake has no external resources.
        },
      };
    },
  };
}

export const fakeConnectorConfigSchema = schemaWithDefaults<ConnectorConfig>({
  accountId: "fake-account",
});

export interface FakeConnectorOptions {
  connection?: ConnectorConnectionState;
  result?: JsonValue;
}

export function createFakeConnectorDriver(options: FakeConnectorOptions = {}): ConnectorDriver {
  const connection = options.connection ?? {
    connectionId: "connection-1",
    app: "calendar" as const,
    status: "active" as const,
    stateRevision: 1,
    capabilities: ["calendar.read"],
  };
  return {
    module: "connector",
    providerId: "fake-connector",
    metadata: metadata("connector", "fake-connector", [
      "connection.read",
      "operation.execute",
      "connection.revoke",
    ]),
    config: { version: "1", schema: fakeConnectorConfigSchema },
    async create(
      _config: ConnectorConfig,
      _context: ProviderCreateContext,
    ): Promise<ConnectorClient> {
      return {
        async getConnection() {
          return structuredClone(connection);
        },
        async execute(_request: ConnectorOperationRequest, _context: ProviderOperationContext) {
          return {
            data: structuredClone(options.result ?? { ok: true }),
            providerOperationId: "fake-operation-1",
          };
        },
        async revoke() {
          connection.status = "revoked";
          connection.stateRevision += 1;
        },
        async close() {},
      };
    },
  };
}

export const fakeNotificationConfigSchema = schemaWithDefaults<NotificationConfig>({
  channel: "in_app",
});

export function createFakeNotificationDriver(
  receipts: NotificationReceipt[] = [],
): NotificationDriver {
  return {
    module: "notification",
    providerId: "fake-notification",
    metadata: metadata("notification", "fake-notification", ["send"]),
    config: { version: "1", schema: fakeNotificationConfigSchema },
    async create(
      _config: NotificationConfig,
      _context: ProviderCreateContext,
    ): Promise<NotificationClient> {
      return {
        async send(_request: NotificationSendRequest) {
          const receipt = {
            accepted: true,
            providerMessageId: `message-${receipts.length + 1}`,
            acceptedAt: new Date(0).toISOString(),
          };
          receipts.push(receipt);
          return receipt;
        },
        async close() {},
      };
    },
  };
}

export class ManualClock {
  constructor(private current = new Date(0)) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
  set(value: string | Date): void {
    this.current = new Date(value);
  }
}

export async function collectAsync<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

export function createAbortSignal(): AbortSignal {
  return new AbortController().signal;
}
