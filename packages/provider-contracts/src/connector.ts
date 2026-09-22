import type {
  AsyncDisposable,
  ProviderConfigDefinition,
  ProviderJsonResult,
  ProviderOperationContext,
  ProviderRegistration,
} from "./types.js";

export interface ConnectorConfig { endpoint?: string; accountId?: string }
export interface ConnectorConnectionState {
  connectionId: string;
  app: "gmail" | "calendar";
  status: "active" | "reauthorization_required" | "revoked" | "expired" | "disconnected";
  stateRevision: number;
  capabilities: readonly string[];
}
export interface ConnectorOperationRequest {
  connectionId: string;
  operation: string;
  input: Record<string, unknown>;
}
export interface ConnectorClient extends AsyncDisposable {
  getConnection(connectionId: string, context: ProviderOperationContext): Promise<ConnectorConnectionState>;
  execute(request: ConnectorOperationRequest, context: ProviderOperationContext): Promise<ProviderJsonResult>;
  revoke(connectionId: string, context: ProviderOperationContext): Promise<void>;
}
export interface ConnectorDriver extends ProviderRegistration<ConnectorConfig, ConnectorClient> {
  readonly module: "connector";
  readonly config: ProviderConfigDefinition<ConnectorConfig>;
}
