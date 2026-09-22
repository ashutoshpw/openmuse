import type { MessagePart } from "@openmuse/contracts";
import type {
  AsyncDisposable,
  ProviderConfigDefinition,
  ProviderCreateContext,
  ProviderRegistration,
  ProviderOperationContext,
  ProviderReference,
} from "./types.js";

export interface ModelConfig {
  defaultModel?: string;
  endpoint?: string;
  organization?: string;
}

export interface ModelToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  parts: MessagePart[];
  toolCallId?: string;
}

export interface ModelGenerateRequest {
  model?: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: "text" | "json";
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; arguments: Record<string, unknown> }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costMinorUnits?: number }
  | { type: "completed"; finishReason: "stop" | "tool_call" | "length" | "content_filter" };

export interface ModelClient extends AsyncDisposable {
  generate(
    request: ModelGenerateRequest,
    context: ProviderOperationContext,
  ): AsyncIterable<ModelEvent>;
  listModels?(context: ProviderOperationContext): Promise<readonly ModelDescriptor[]>;
}

export interface ModelDescriptor {
  id: string;
  displayName?: string;
  contextWindow?: number;
  capabilities: readonly ("text" | "vision" | "tools" | "reasoning" | "json")[];
}

export interface ModelDriver extends ProviderRegistration<ModelConfig, ModelClient> {
  readonly module: "model";
  readonly config: ProviderConfigDefinition<ModelConfig>;
  create(config: ModelConfig, context: ProviderCreateContext): Promise<ModelClient>;
}
