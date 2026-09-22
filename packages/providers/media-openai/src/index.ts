import { z } from "zod";
import {
  ProviderOperationError,
  redactProviderDetails,
  type ImageClient,
  type ImageConfig,
  type ImageDriver,
  type ImageGenerateRequest,
  type ImageResult,
  type ProviderBlob,
  type ProviderConfigDefinition,
  type ProviderCreateContext,
  type ProviderOperationContext,
  type ProviderReference,
  type ProviderModule,
  type SttClient,
  type SttConfig,
  type SttDriver,
  type SttTranscribeRequest,
  type Transcript,
  type TranscriptWord,
  type TtsClient,
  type TtsConfig,
  type TtsDriver,
  type TtsResult,
  type TtsSynthesizeRequest,
} from "@openmuse/provider-contracts";
import {
  asRecord,
  createHttpClient,
  fromBase64,
  type FetchLike,
  type HttpClient,
  type HttpRequestContext,
} from "@openmuse/provider-http";

const providerId = "openai";
const imageContext = (operation: string): HttpRequestContext => ({
  providerId,
  module: "image",
  operation,
});
const sttContext = (operation: string): HttpRequestContext => ({
  providerId,
  module: "stt",
  operation,
});
const ttsContext = (operation: string): HttpRequestContext => ({
  providerId,
  module: "tts",
  operation,
});

const defaultEndpoint = "https://api.openai.com/v1";
const maxResponseBytesSchema = z
  .number()
  .int()
  .min(16 * 1024)
  .max(100 * 1024 * 1024);
const requestTimeoutSchema = z
  .number()
  .int()
  .min(1000)
  .max(15 * 60 * 1000);

export interface OpenAiImageConfig extends ImageConfig {
  endpoint: string;
  apiKeySecret: string;
  defaultModel: string;
  outputFormat: "png" | "jpeg" | "webp";
  maxPromptCharacters: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
}

export interface OpenAiSttConfig extends SttConfig {
  endpoint: string;
  apiKeySecret: string;
  defaultModel: string;
  diarizationModel: string;
  maxInputBytes: number;
  maxResponseBytes: number;
  maxStreamDurationMs: number;
  requestTimeoutMs: number;
}

export interface OpenAiTtsConfig extends TtsConfig {
  endpoint: string;
  apiKeySecret: string;
  defaultModel: string;
  maxInputCharacters: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
}

export type MediaReferenceResolver = (
  reference: ProviderReference,
  context: ProviderOperationContext,
) => Promise<ProviderBlob>;

export interface OpenAiImageDriverOptions {
  fetch?: FetchLike;
}

export interface OpenAiSttDriverOptions {
  fetch?: FetchLike;
  resolveReference?: MediaReferenceResolver;
}

export interface OpenAiTtsDriverOptions {
  fetch?: FetchLike;
}

const imageConfigSchema = z
  .object({
    endpoint: z.string().url().default(defaultEndpoint),
    apiKeySecret: z.string().trim().min(1),
    defaultModel: z.string().trim().min(1).default("gpt-image-1"),
    outputFormat: z.enum(["png", "jpeg", "webp"]).default("png"),
    maxPromptCharacters: z.number().int().min(1).max(32_000).default(32_000),
    maxResponseBytes: maxResponseBytesSchema.default(20 * 1024 * 1024),
    requestTimeoutMs: requestTimeoutSchema.default(120_000),
  })
  .strict();

const sttConfigSchema = z
  .object({
    endpoint: z.string().url().default(defaultEndpoint),
    apiKeySecret: z.string().trim().min(1),
    defaultModel: z.string().trim().min(1).default("gpt-4o-transcribe"),
    diarizationModel: z.string().trim().min(1).default("gpt-4o-transcribe-diarize"),
    defaultLanguage: z.string().trim().min(1).optional(),
    maxInputBytes: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024)
      .default(25 * 1024 * 1024),
    maxResponseBytes: maxResponseBytesSchema.default(20 * 1024 * 1024),
    maxStreamDurationMs: z
      .number()
      .int()
      .min(1000)
      .max(15 * 60 * 1000)
      .default(120_000),
    requestTimeoutMs: requestTimeoutSchema.default(120_000),
  })
  .strict();

const ttsConfigSchema = z
  .object({
    endpoint: z.string().url().default(defaultEndpoint),
    apiKeySecret: z.string().trim().min(1),
    defaultModel: z.string().trim().min(1).default("gpt-4o-mini-tts"),
    defaultVoice: z.string().trim().min(1).default("alloy"),
    maxInputCharacters: z.number().int().min(1).max(1_000_000).default(100_000),
    maxResponseBytes: maxResponseBytesSchema.default(20 * 1024 * 1024),
    requestTimeoutMs: requestTimeoutSchema.default(120_000),
  })
  .strict();

function invalid(
  module: ProviderModule,
  operation: string,
  message: string,
  safeMessage = "The provider returned an invalid media response.",
): ProviderOperationError {
  return new ProviderOperationError({
    code: "failed",
    message,
    safeMessage,
    retryable: false,
    uncertain: false,
    providerId,
    module,
    operation,
  });
}

function missingSecret(module: ProviderModule): ProviderOperationError {
  return new ProviderOperationError({
    code: "authentication_required",
    message: "An OpenAI API key secret resolver is required.",
    safeMessage: "The media provider is not configured.",
    retryable: false,
    uncertain: false,
    providerId,
    module,
    operation: "authenticate",
  });
}

/** Build an HTTP client whose secret reference is resolved without exposing the value in config. */
function createAuthenticatedHttp(
  endpoint: string,
  fetch: FetchLike | undefined,
  timeoutMs: number,
  createContext: ProviderCreateContext,
  secretReference: string,
  module: ProviderModule,
  secrets: Set<string>,
): HttpClient {
  return createHttpClient({
    baseUrl: endpoint,
    fetch: fetch ?? globalThis.fetch,
    defaultTimeoutMs: timeoutMs,
    headers: async () => {
      if (!createContext.secrets) throw missingSecret(module);
      const apiKey = await createContext.secrets.resolve(secretReference, createContext.signal);
      if (!apiKey) throw missingSecret(module);
      secrets.add(apiKey);
      return { Authorization: `Bearer ${apiKey}` };
    },
  });
}

function redactText(value: string, secrets: ReadonlySet<string>): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.length > 2048 ? `${redacted.slice(0, 2048)}…` : redacted;
}

function redactValue(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactValue(child, secrets)]),
    );
  return value;
}

function redactError(
  error: unknown,
  secrets: ReadonlySet<string>,
  module: ProviderModule,
  operation: string,
): ProviderOperationError {
  if (error instanceof ProviderOperationError) {
    return new ProviderOperationError({
      code: error.code,
      message: redactText(error.message, secrets),
      safeMessage: redactText(error.safeMessage, secrets),
      retryable: error.retryable,
      uncertain: error.uncertain,
      providerId: error.providerId ?? providerId,
      module: error.module ?? module,
      operation: error.operation ?? operation,
      ...(error.providerCode === undefined
        ? {}
        : { providerCode: redactText(error.providerCode, secrets) }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.details === undefined
        ? {}
        : {
            details: redactProviderDetails(redactValue(error.details, secrets)) as Record<
              string,
              never
            >,
          }),
    });
  }
  return new ProviderOperationError({
    code: "failed",
    message: redactText(
      error instanceof Error ? error.message : "Provider operation failed",
      secrets,
    ),
    safeMessage: "The provider operation could not be completed.",
    retryable: false,
    uncertain: false,
    providerId,
    module,
    operation,
  });
}

function imageSize(request: ImageGenerateRequest): string | undefined {
  if (request.width === undefined && request.height === undefined) return undefined;
  if (
    request.width === undefined ||
    request.height === undefined ||
    !Number.isInteger(request.width) ||
    !Number.isInteger(request.height)
  )
    throw invalid(
      "image",
      "generate",
      "Image width and height must be supplied together.",
      "The image dimensions are invalid.",
    );
  const size = `${request.width}x${request.height}`;
  if (!["256x256", "512x512", "1024x1024", "1792x1024", "1024x1792"].includes(size))
    throw invalid(
      "image",
      "generate",
      `OpenAI does not support image size ${size}.`,
      "The requested image dimensions are not supported.",
    );
  return size;
}

function imageContentType(format: OpenAiImageConfig["outputFormat"]): string {
  return format === "jpeg" ? "image/jpeg" : format === "webp" ? "image/webp" : "image/png";
}

function imageFileName(format: OpenAiImageConfig["outputFormat"]): string {
  return `openai-image.${format === "jpeg" ? "jpg" : format}`;
}

function parseImageResponse(value: unknown, config: OpenAiImageConfig): ImageResult {
  const record = asRecord(value, imageContext("generate"));
  if (!Array.isArray(record.data) || record.data.length === 0)
    throw invalid("image", "generate", "OpenAI image response is missing data.");
  const first = asRecord(record.data[0], imageContext("generate"));
  if (typeof first.b64_json !== "string" || first.b64_json.length === 0)
    throw invalid(
      "image",
      "generate",
      "OpenAI returned an image URL or an empty image instead of base64 data.",
      "The image provider did not return a safe image payload.",
    );
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(first.b64_json);
  } catch (error) {
    throw invalid(
      "image",
      "generate",
      error instanceof Error ? error.message : "OpenAI returned invalid base64 image data.",
    );
  }
  if (bytes.byteLength === 0)
    throw invalid("image", "generate", "OpenAI returned an empty image payload.");
  return {
    image: {
      bytes,
      contentType: imageContentType(config.outputFormat),
      fileName: imageFileName(config.outputFormat),
    },
    ...(typeof record.id === "string" && record.id.length > 0
      ? { providerOperationId: record.id }
      : {}),
  };
}

function arrayBufferFor(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
    return bytes.buffer as ArrayBuffer;
  return bytes.slice().buffer as ArrayBuffer;
}

function blobFor(bytes: Uint8Array, contentType: string): Blob {
  return new Blob([arrayBufferFor(bytes)], { type: contentType || "application/octet-stream" });
}

async function resolveAudio(
  request: SttTranscribeRequest,
  operation: ProviderOperationContext,
  resolver: MediaReferenceResolver | undefined,
  module: ProviderModule,
): Promise<ProviderBlob> {
  if ("bytes" in request.audio) {
    if (!(request.audio.bytes instanceof Uint8Array))
      throw invalid(
        module,
        "transcribe",
        "Audio bytes must be a Uint8Array.",
        "The audio input is invalid.",
      );
    return request.audio;
  }
  if (!resolver)
    throw invalid(
      module,
      "transcribe",
      `Audio reference ${request.audio.id} cannot be resolved by this provider.`,
      "The audio reference is unavailable to the media provider.",
    );
  const blob = await resolver(request.audio, operation);
  if (!(blob.bytes instanceof Uint8Array) || blob.bytes.byteLength === 0)
    throw invalid(
      module,
      "transcribe",
      "The audio reference resolved to no bytes.",
      "The audio input is invalid.",
    );
  return blob;
}

function audioContentType(contentType: string): boolean {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return normalized?.startsWith("audio/") ?? false;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function milliseconds(
  record: Record<string, unknown>,
  secondsKey: string,
  msKey: string,
): number | undefined {
  if (finite(record[msKey])) return Math.round(record[msKey] as number);
  if (finite(record[secondsKey])) return Math.round((record[secondsKey] as number) * 1000);
  return undefined;
}

function parseWord(
  value: unknown,
  module: ProviderModule,
  inheritedSpeaker?: string,
): TranscriptWord {
  const record = asRecord(
    value,
    module === "stt" ? sttContext("transcribe") : ttsContext("transcribe"),
  );
  const text = typeof record.word === "string" ? record.word : record.text;
  if (typeof text !== "string")
    throw invalid(module, "transcribe", "The transcript contains a word without text.");
  const speaker = typeof record.speaker === "string" ? record.speaker : inheritedSpeaker;
  const startMs = milliseconds(record, "start", "startMs");
  const endMs = milliseconds(record, "end", "endMs");
  return {
    text,
    ...(startMs === undefined ? {} : { startMs }),
    ...(endMs === undefined ? {} : { endMs }),
    ...(speaker ? { speaker } : {}),
  };
}

function parseTranscriptValue(
  value: unknown,
  operationId: string,
  module: "stt" = "stt",
): Transcript {
  if (typeof value === "string") return { text: value, providerOperationId: operationId };
  const record = asRecord(value, sttContext("transcribe"));
  const rawWords = record.words;
  const words: TranscriptWord[] = Array.isArray(rawWords)
    ? rawWords.map((word) => parseWord(word, module))
    : [];
  if (Array.isArray(record.segments)) {
    for (const segment of record.segments) {
      const segmentRecord = asRecord(segment, sttContext("transcribe"));
      const speaker = typeof segmentRecord.speaker === "string" ? segmentRecord.speaker : undefined;
      if (Array.isArray(segmentRecord.words)) {
        for (const word of segmentRecord.words) words.push(parseWord(word, module, speaker));
      } else if (typeof segmentRecord.text === "string" && segmentRecord.text.length > 0) {
        words.push(parseWord(segmentRecord, module, speaker));
      }
    }
  }
  const text =
    typeof record.text === "string" ? record.text : words.map((word) => word.text).join(" ");
  if (typeof text !== "string")
    throw invalid("stt", "transcribe", "The transcript response is missing text.");
  const language = typeof record.language === "string" ? record.language : undefined;
  const id =
    typeof record.id === "string"
      ? record.id
      : typeof record.request_id === "string"
        ? record.request_id
        : operationId;
  return {
    text,
    ...(language ? { language } : {}),
    ...(words.length > 0 ? { words } : {}),
    providerOperationId: id,
  };
}

async function boundedText(
  response: Response,
  http: HttpClient,
  maxResponseBytes: number,
  signal: AbortSignal,
  maxDurationMs: number,
  module: ProviderModule,
): Promise<string> {
  try {
    const bytes = await http.readResponseBytes(
      response,
      { signal, maxBytes: maxResponseBytes, maxDurationMs },
      sttContext("transcribe"),
    );
    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (
      error instanceof ProviderOperationError &&
      error.code === "failed" &&
      error.safeMessage === "The provider response was too large."
    )
      throw invalid(
        module,
        "transcribe",
        "Provider response exceeded its size limit.",
        "The provider response was too large.",
      );
    throw error;
  }
}

async function parseTranscriptResponse(
  response: Response,
  http: HttpClient,
  config: OpenAiSttConfig,
  operation: ProviderOperationContext,
): Promise<Transcript> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream")) {
    const deltas: string[] = [];
    let finalValue: unknown;
    for await (const payload of http.sse(
      response,
      {
        signal: operation.signal,
        maxBytes: config.maxResponseBytes,
        maxDurationMs: config.maxStreamDurationMs,
      },
      sttContext("transcribe.stream"),
    )) {
      if (payload === "[DONE]") break;
      let value: unknown;
      try {
        value = JSON.parse(payload);
      } catch {
        if (payload) deltas.push(payload);
        continue;
      }
      const record = asRecord(value, sttContext("transcribe.stream"));
      if (record.type === "transcript.text.delta" || record.type === "transcript.delta") {
        if (typeof record.delta === "string") deltas.push(record.delta);
      } else if (record.type === "transcript.text.done" || record.type === "transcript.done") {
        finalValue = record;
      } else if (typeof record.text === "string" && record.type !== "transcript.text.delta") {
        finalValue = record;
      } else if (typeof record.delta === "string") {
        deltas.push(record.delta);
      }
    }
    if (finalValue !== undefined) {
      const transcript = parseTranscriptValue(finalValue, operation.operationId);
      if (transcript.text.length === 0 && deltas.length > 0)
        return { ...transcript, text: deltas.join("") };
      return transcript;
    }
    return { text: deltas.join(""), providerOperationId: operation.operationId };
  }
  const raw = await boundedText(
    response,
    http,
    config.maxResponseBytes,
    operation.signal,
    config.requestTimeoutMs,
    "stt",
  );
  if (contentType.includes("text/plain")) return parseTranscriptValue(raw, operation.operationId);
  let value: unknown;
  try {
    value = raw.length === 0 ? undefined : JSON.parse(raw);
  } catch (error) {
    throw invalid(
      "stt",
      "transcribe",
      error instanceof Error ? error.message : "Invalid JSON transcript response.",
    );
  }
  return parseTranscriptValue(value, operation.operationId);
}

function ttsContentType(format: NonNullable<TtsSynthesizeRequest["format"]>): string {
  return format === "mp3" ? "audio/mpeg" : format === "wav" ? "audio/wav" : "audio/pcm";
}

function isTtsFormat(value: unknown): value is NonNullable<TtsSynthesizeRequest["format"]> {
  return value === "mp3" || value === "wav" || value === "pcm";
}

function ttsFileName(format: NonNullable<TtsSynthesizeRequest["format"]>): string {
  return `openai-speech.${format}`;
}

function assertTtsContentType(actual: string, expected: string): void {
  if (!actual || actual === expected) return;
  const normalized = actual.split(";", 1)[0]?.trim().toLowerCase();
  const accepted =
    expected === "audio/mpeg"
      ? ["audio/mpeg", "audio/mp3"]
      : expected === "audio/wav"
        ? ["audio/wav", "audio/wave", "audio/x-wav"]
        : ["audio/pcm", "application/octet-stream"];
  if (!normalized || !accepted.includes(normalized))
    throw invalid(
      "tts",
      "synthesize",
      `OpenAI returned ${actual} for an ${expected} request.`,
      "The speech provider returned an unsupported audio format.",
    );
}

function imageDriverMetadata() {
  return {
    providerId,
    displayName: "OpenAI image generation",
    version: "0.1.0",
    configVersion: "1",
    buildDigest: "builtin:openai-image:0.1.0",
    capabilities: [{ key: "generate" }, { key: "base64-output" }, { key: "single-image" }],
    requiredSecrets: [
      { name: "apiKeySecret", description: "OpenAI API key reference", required: true },
    ],
    trusted: true,
  } as const;
}

function sttDriverMetadata() {
  return {
    providerId,
    displayName: "OpenAI speech-to-text",
    version: "0.1.0",
    configVersion: "1",
    buildDigest: "builtin:openai-stt:0.1.0",
    capabilities: [{ key: "transcribe" }, { key: "stream" }, { key: "diarization" }],
    requiredSecrets: [
      { name: "apiKeySecret", description: "OpenAI API key reference", required: true },
    ],
    trusted: true,
  } as const;
}

function ttsDriverMetadata() {
  return {
    providerId,
    displayName: "OpenAI text-to-speech",
    version: "0.1.0",
    configVersion: "1",
    buildDigest: "builtin:openai-tts:0.1.0",
    capabilities: [{ key: "synthesize" }, { key: "binary-output" }],
    requiredSecrets: [
      { name: "apiKeySecret", description: "OpenAI API key reference", required: true },
    ],
    trusted: true,
  } as const;
}

export function createOpenAiImageDriver(options: OpenAiImageDriverOptions = {}): ImageDriver {
  return {
    module: "image",
    providerId,
    metadata: imageDriverMetadata(),
    config: {
      version: "1",
      schema: imageConfigSchema as unknown as ProviderConfigDefinition<ImageConfig>["schema"],
    },
    async create(
      rawConfig: ImageConfig,
      createContext: ProviderCreateContext,
    ): Promise<ImageClient> {
      const config = rawConfig as OpenAiImageConfig;
      const secrets = new Set<string>();
      const http = createAuthenticatedHttp(
        config.endpoint,
        options.fetch,
        config.requestTimeoutMs,
        createContext,
        config.apiKeySecret,
        "image",
        secrets,
      );
      return {
        async generate(
          request: ImageGenerateRequest,
          operation: ProviderOperationContext,
        ): Promise<ImageResult> {
          if (
            request.prompt.trim().length === 0 ||
            request.prompt.length > config.maxPromptCharacters
          )
            throw invalid(
              "image",
              "generate",
              "The image prompt is empty or exceeds its size limit.",
              "The image prompt is invalid.",
            );
          if (request.reference)
            throw invalid(
              "image",
              "generate",
              "OpenAI image references are not supported by this bounded adapter.",
              "Image references are not supported by this provider configuration.",
            );
          const model = request.model ?? config.defaultModel;
          const size = imageSize(request);
          const body: Record<string, unknown> = { model, prompt: request.prompt, n: 1 };
          if (size) body.size = size;
          if (model.startsWith("gpt-image")) body.output_format = config.outputFormat;
          else body.response_format = "b64_json";
          try {
            return await http.json(
              {
                method: "POST",
                path: "/images/generations",
                body,
                signal: operation.signal,
                maxResponseBytes: config.maxResponseBytes,
                uncertainOnNetworkFailure: true,
              },
              imageContext("generate"),
              (value) => parseImageResponse(value, config),
            );
          } catch (error) {
            throw redactError(error, secrets, "image", "generate");
          }
        },
        async close() {},
      };
    },
  };
}

export function createOpenAiSttDriver(options: OpenAiSttDriverOptions = {}): SttDriver {
  return {
    module: "stt",
    providerId,
    metadata: sttDriverMetadata(),
    config: {
      version: "1",
      schema: sttConfigSchema as unknown as ProviderConfigDefinition<SttConfig>["schema"],
    },
    async create(rawConfig: SttConfig, createContext: ProviderCreateContext): Promise<SttClient> {
      const config = rawConfig as OpenAiSttConfig;
      const secrets = new Set<string>();
      const http = createAuthenticatedHttp(
        config.endpoint,
        options.fetch,
        config.requestTimeoutMs,
        createContext,
        config.apiKeySecret,
        "stt",
        secrets,
      );
      return {
        async transcribe(
          request: SttTranscribeRequest,
          operation: ProviderOperationContext,
        ): Promise<Transcript> {
          const audio = await resolveAudio(request, operation, options.resolveReference, "stt");
          if (audio.bytes.byteLength === 0 || audio.bytes.byteLength > config.maxInputBytes)
            throw invalid(
              "stt",
              "transcribe",
              "Audio input exceeds the provider size limit.",
              "The audio input is too large.",
            );
          if (!audioContentType(audio.contentType))
            throw invalid(
              "stt",
              "transcribe",
              `OpenAI accepts audio input only, not ${audio.contentType}.`,
              "Only audio input is supported.",
            );
          const form = new FormData();
          form.append(
            "file",
            blobFor(audio.bytes, audio.contentType),
            audio.fileName ?? "audio.bin",
          );
          form.append("model", request.diarize ? config.diarizationModel : config.defaultModel);
          form.append("response_format", request.diarize ? "diarized_json" : "verbose_json");
          if (request.language ?? config.defaultLanguage)
            form.append("language", request.language ?? config.defaultLanguage!);
          if (!request.diarize) form.append("timestamp_granularities[]", "word");
          try {
            const response = await http.request(
              {
                method: "POST",
                path: "/audio/transcriptions",
                body: form,
                signal: operation.signal,
                uncertainOnNetworkFailure: true,
              },
              sttContext("transcribe"),
            );
            return await parseTranscriptResponse(response, http, config, operation);
          } catch (error) {
            throw redactError(error, secrets, "stt", "transcribe");
          }
        },
        async close() {},
      };
    },
  };
}

export function createOpenAiTtsDriver(options: OpenAiTtsDriverOptions = {}): TtsDriver {
  return {
    module: "tts",
    providerId,
    metadata: ttsDriverMetadata(),
    config: {
      version: "1",
      schema: ttsConfigSchema as unknown as ProviderConfigDefinition<TtsConfig>["schema"],
    },
    async create(rawConfig: TtsConfig, createContext: ProviderCreateContext): Promise<TtsClient> {
      const config = rawConfig as OpenAiTtsConfig;
      const secrets = new Set<string>();
      const http = createAuthenticatedHttp(
        config.endpoint,
        options.fetch,
        config.requestTimeoutMs,
        createContext,
        config.apiKeySecret,
        "tts",
        secrets,
      );
      return {
        async synthesize(
          request: TtsSynthesizeRequest,
          operation: ProviderOperationContext,
        ): Promise<TtsResult> {
          if (request.text.trim().length === 0 || request.text.length > config.maxInputCharacters)
            throw invalid(
              "tts",
              "synthesize",
              "Speech input is empty or exceeds its size limit.",
              "The speech input is invalid.",
            );
          const format = request.format ?? "mp3";
          if (!isTtsFormat(format))
            throw invalid(
              "tts",
              "synthesize",
              "The requested speech format is not supported.",
              "The speech format is invalid.",
            );
          try {
            const response = await http.request(
              {
                method: "POST",
                path: "/audio/speech",
                body: {
                  model: config.defaultModel,
                  input: request.text,
                  voice: request.voice ?? config.defaultVoice,
                  response_format: format,
                },
                signal: operation.signal,
                uncertainOnNetworkFailure: true,
              },
              ttsContext("synthesize"),
            );
            const actualContentType = response.headers.get("content-type") ?? "";
            const expectedContentType = ttsContentType(format);
            if (
              actualContentType.toLowerCase().includes("event-stream") ||
              actualContentType.toLowerCase().includes("json")
            )
              throw invalid(
                "tts",
                "synthesize",
                "OpenAI returned a streaming or JSON response for a binary speech request.",
                "The speech provider returned an invalid audio response.",
              );
            assertTtsContentType(actualContentType, expectedContentType);
            let bytes: Uint8Array;
            try {
              bytes = await http.readResponseBytes(
                response,
                {
                  signal: operation.signal,
                  maxBytes: config.maxResponseBytes,
                  maxDurationMs: config.requestTimeoutMs,
                },
                ttsContext("synthesize"),
              );
            } catch (error) {
              if (
                error instanceof ProviderOperationError &&
                error.code === "failed" &&
                error.safeMessage === "The provider response was too large."
              )
                throw invalid(
                  "tts",
                  "synthesize",
                  "Speech response exceeded its size limit.",
                  "The speech provider response was too large.",
                );
              throw error;
            }
            if (bytes.byteLength === 0)
              throw invalid(
                "tts",
                "synthesize",
                "Speech response exceeded its size limit.",
                "The speech provider response was too large.",
              );
            return {
              audio: { bytes, contentType: expectedContentType, fileName: ttsFileName(format) },
            };
          } catch (error) {
            throw redactError(error, secrets, "tts", "synthesize");
          }
        },
        async close() {},
      };
    },
  };
}

export {
  imageConfigSchema as openAiImageConfigSchema,
  sttConfigSchema as openAiSttConfigSchema,
  ttsConfigSchema as openAiTtsConfigSchema,
};
