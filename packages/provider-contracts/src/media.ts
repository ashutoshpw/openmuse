import type {
  AsyncDisposable,
  ProviderBlob,
  ProviderConfigDefinition,
  ProviderCreateContext,
  ProviderOperationContext,
  ProviderReference,
  ProviderRegistration,
} from "./types.js";

export interface ImageConfig { endpoint?: string; defaultModel?: string }
export interface ImageGenerateRequest {
  prompt: string;
  model?: string;
  width?: number;
  height?: number;
  reference?: ProviderReference;
}
export interface ImageResult { image: ProviderBlob; providerOperationId?: string }
export interface ImageClient extends AsyncDisposable {
  generate(request: ImageGenerateRequest, context: ProviderOperationContext): Promise<ImageResult>;
}
export interface ImageDriver extends ProviderRegistration<ImageConfig, ImageClient> {
  readonly module: "image";
  readonly config: ProviderConfigDefinition<ImageConfig>;
}

export interface SttConfig { endpoint?: string; defaultLanguage?: string }
export interface SttTranscribeRequest { audio: ProviderBlob | ProviderReference; language?: string; diarize?: boolean }
export interface TranscriptWord { text: string; startMs?: number; endMs?: number; speaker?: string }
export interface Transcript { text: string; language?: string; words?: TranscriptWord[]; providerOperationId?: string }
export interface SttClient extends AsyncDisposable {
  transcribe(request: SttTranscribeRequest, context: ProviderOperationContext): Promise<Transcript>;
}
export interface SttDriver extends ProviderRegistration<SttConfig, SttClient> {
  readonly module: "stt";
  readonly config: ProviderConfigDefinition<SttConfig>;
}

export interface TtsConfig { endpoint?: string; defaultVoice?: string }
export interface TtsSynthesizeRequest { text: string; voice?: string; format?: "mp3" | "wav" | "pcm" }
export interface TtsResult { audio: ProviderBlob; providerOperationId?: string }
export interface TtsClient extends AsyncDisposable {
  synthesize(request: TtsSynthesizeRequest, context: ProviderOperationContext): Promise<TtsResult>;
}
export interface TtsDriver extends ProviderRegistration<TtsConfig, TtsClient> {
  readonly module: "tts";
  readonly config: ProviderConfigDefinition<TtsConfig>;
}
