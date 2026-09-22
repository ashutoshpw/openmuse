import type {
  AsyncDisposable,
  ProviderConfigDefinition,
  ProviderCreateContext,
  ProviderOperationContext,
  ProviderRegistration,
} from "./types.js";

export interface RealtimeConfig { endpoint?: string; defaultModel?: string }
export interface RealtimeConnectRequest { model?: string; instructions?: string; modalities?: ("text" | "audio")[] }
export type RealtimeEvent =
  | { type: "connected"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "audio_delta"; bytes: Uint8Array; contentType: string }
  | { type: "input_transcript"; text: string; final: boolean }
  | { type: "turn_completed" }
  | { type: "error"; message: string };
export interface RealtimeSession extends AsyncDisposable {
  readonly events: AsyncIterable<RealtimeEvent>;
  sendText(text: string, context: ProviderOperationContext): Promise<void>;
  sendAudio(bytes: Uint8Array, contentType: string, context: ProviderOperationContext): Promise<void>;
  interrupt(context: ProviderOperationContext): Promise<void>;
}
export interface RealtimeClient extends AsyncDisposable {
  connect(request: RealtimeConnectRequest, context: ProviderOperationContext): Promise<RealtimeSession>;
}
export interface RealtimeDriver extends ProviderRegistration<RealtimeConfig, RealtimeClient> {
  readonly module: "realtime";
  readonly config: ProviderConfigDefinition<RealtimeConfig>;
}
