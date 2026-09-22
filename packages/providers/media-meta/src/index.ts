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
  type ProviderModule,
  type ProviderOperationContext,
  type ProviderReference,
  type SttClient,
  type SttConfig,
  type SttDriver,
  type SttTranscribeRequest,
  type Transcript,
  type TranscriptWord,
} from "@openmuse/provider-contracts";
import {
  asRecord,
  createHttpClient,
  fromBase64,
  type FetchLike,
  type HttpClient,
  type HttpRequestContext,
} from "@openmuse/provider-http";

const providerId = "meta-llama";
const defaultEndpoint = "https://api.meta.ai/v1";
const maxRequestBytesSchema = z
  .number()
  .int()
  .min(1)
  .max(32 * 1024 * 1024);
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
const maxAudioDurationMs = 10 * 60 * 1000;

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

export interface MetaImageConfig extends ImageConfig {
  endpoint: string;
  apiKeySecret: string;
  defaultModel: string;
  outputFormat: "png" | "jpeg" | "webp";
  maxPromptCharacters: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
}

export interface MetaSttConfig extends SttConfig {
  endpoint: string;
  apiKeySecret: string;
  defaultModel: string;
  maxInputBytes: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxDurationMs: number;
  requestTimeoutMs: number;
}

export interface MetaImageDriverOptions {
  fetch?: FetchLike;
}

export interface MetaSttDriverOptions {
  fetch?: FetchLike;
  resolveReference?: MetaMediaReferenceResolver;
}

export type MetaMediaReferenceResolver = (
  reference: ProviderReference,
  context: ProviderOperationContext,
) => Promise<ProviderBlob>;

const imageConfigSchema = z
  .object({
    endpoint: z.string().url().default(defaultEndpoint),
    apiKeySecret: z.string().trim().min(1),
    defaultModel: z.string().trim().min(1).default("muse-image-1.0"),
    outputFormat: z.enum(["png", "jpeg", "webp"]).default("webp"),
    maxPromptCharacters: z.number().int().min(1).max(32_000).default(32_000),
    maxRequestBytes: maxRequestBytesSchema.default(256 * 1024),
    maxResponseBytes: maxResponseBytesSchema.default(20 * 1024 * 1024),
    requestTimeoutMs: requestTimeoutSchema.default(120_000),
  })
  .strict();

const sttConfigSchema = z
  .object({
    endpoint: z.string().url().default(defaultEndpoint),
    apiKeySecret: z.string().trim().min(1),
    defaultModel: z.string().trim().min(1).default("muse-voice-transcribe-1.0"),
    defaultLanguage: z.string().trim().min(1).optional(),
    maxInputBytes: z
      .number()
      .int()
      .min(1)
      .max(32 * 1024 * 1024)
      .default(32 * 1024 * 1024),
    maxRequestBytes: maxRequestBytesSchema.default(32 * 1024 * 1024),
    maxResponseBytes: maxResponseBytesSchema.default(20 * 1024 * 1024),
    maxDurationMs: z.number().int().min(1).max(maxAudioDurationMs).default(maxAudioDurationMs),
    requestTimeoutMs: requestTimeoutSchema.default(120_000),
  })
  .strict();

function invalid(
  module: ProviderModule,
  operation: string,
  message: string,
  safeMessage = "The media provider returned an invalid response.",
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

function cancelled(module: ProviderModule, operation: string): ProviderOperationError {
  return new ProviderOperationError({
    code: "cancelled",
    message: "The provider operation was cancelled.",
    safeMessage: "The provider operation was cancelled.",
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
    message: "A Meta API key secret resolver is required.",
    safeMessage: "The media provider is not configured.",
    retryable: false,
    uncertain: false,
    providerId,
    module,
    operation: "authenticate",
  });
}

function assertNotAborted(signal: AbortSignal, module: ProviderModule, operation: string): void {
  if (signal.aborted) throw cancelled(module, operation);
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

/**
 * The shared HTTP boundary keeps provider details out of safeMessage, but the
 * internal message can still echo a credential if a provider does so. Clone
 * normalized errors with the resolved secret removed before they leave this
 * adapter.
 */
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
  const message =
    error instanceof Error ? redactText(error.message, secrets) : "Provider operation failed";
  return new ProviderOperationError({
    code: "failed",
    message,
    safeMessage: "The provider operation could not be completed.",
    retryable: false,
    uncertain: false,
    providerId,
    module,
    operation,
  });
}

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
      let apiKey: string;
      try {
        apiKey = await createContext.secrets.resolve(secretReference, createContext.signal);
      } catch {
        throw missingSecret(module);
      }
      if (!apiKey) throw missingSecret(module);
      secrets.add(apiKey);
      return { Authorization: `Bearer ${apiKey}` };
    },
  });
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function imageContentType(format: MetaImageConfig["outputFormat"]): string {
  return format === "jpeg" ? "image/jpeg" : format === "png" ? "image/png" : "image/webp";
}

function imageFileName(format: MetaImageConfig["outputFormat"]): string {
  return `meta-image.${format === "jpeg" ? "jpg" : format}`;
}

function imageSize(request: ImageGenerateRequest): string | undefined {
  if (request.width === undefined && request.height === undefined) return undefined;
  if (
    request.width === undefined ||
    request.height === undefined ||
    !Number.isInteger(request.width) ||
    !Number.isInteger(request.height) ||
    request.width < 1 ||
    request.height < 1 ||
    request.width > 4096 ||
    request.height > 4096
  )
    throw invalid(
      "image",
      "generate",
      "Image width and height must be supplied together as bounded positive integers.",
      "The image dimensions are invalid.",
    );
  return `${request.width}x${request.height}`;
}

function parseImageResponse(
  value: unknown,
  config: MetaImageConfig,
  operation: ProviderOperationContext,
): ImageResult {
  const record = asRecord(value, imageContext("generate"));
  if (!Array.isArray(record.data) || record.data.length === 0)
    throw invalid("image", "generate", "Meta image response is missing data.");
  const first = asRecord(record.data[0], imageContext("generate"));
  if (typeof first.b64_json !== "string" || first.b64_json.length === 0)
    throw invalid(
      "image",
      "generate",
      "Meta returned a URL or an empty image instead of base64 data.",
      "The image provider did not return a safe image payload.",
    );
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(first.b64_json);
  } catch {
    throw invalid("image", "generate", "Meta returned invalid base64 image data.");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > config.maxResponseBytes)
    throw invalid(
      "image",
      "generate",
      "Meta returned an image outside the configured size limit.",
      "The image provider response was too large.",
    );
  const outputFormat =
    record.output_format === "png" ||
    record.output_format === "jpeg" ||
    record.output_format === "webp"
      ? record.output_format
      : config.outputFormat;
  const providerOperationId =
    typeof record.id === "string" && record.id.length > 0 ? record.id : operation.operationId;
  return {
    image: {
      bytes,
      contentType: imageContentType(outputFormat),
      fileName: imageFileName(outputFormat),
    },
    providerOperationId,
  };
}

function arrayBufferFor(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
    return bytes.buffer as ArrayBuffer;
  return bytes.slice().buffer as ArrayBuffer;
}

function blobFor(bytes: Uint8Array, contentType: string): Blob {
  return new Blob([arrayBufferFor(bytes)], { type: contentType });
}

async function resolveAudio(
  request: SttTranscribeRequest,
  operation: ProviderOperationContext,
  resolver: MetaMediaReferenceResolver | undefined,
): Promise<ProviderBlob> {
  if ("bytes" in request.audio) {
    if (!(request.audio.bytes instanceof Uint8Array))
      throw invalid(
        "stt",
        "transcribe",
        "Audio bytes must be a Uint8Array.",
        "The audio input is invalid.",
      );
    return request.audio;
  }
  if (!resolver)
    throw invalid(
      "stt",
      "transcribe",
      `Audio reference ${request.audio.id} cannot be resolved by this provider.`,
      "The audio reference is unavailable to the media provider.",
    );
  const audio = await resolver(request.audio, operation);
  if (!(audio.bytes instanceof Uint8Array) || audio.bytes.byteLength === 0)
    throw invalid(
      "stt",
      "transcribe",
      "The audio reference resolved to no bytes.",
      "The audio input is invalid.",
    );
  return audio;
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

interface WavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  byteRate: number;
  blockAlign: number;
  dataBytes: number;
}

function parseWav(bytes: Uint8Array, maxDurationMs: number): WavInfo {
  if (bytes.byteLength < 12 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WAVE"))
    throw invalid(
      "stt",
      "transcribe",
      "The audio is not a RIFF/WAVE file.",
      "Only WAV audio is supported.",
    );

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffSize = view.getUint32(4, true);
  const riffEnd = 8 + riffSize;
  if (riffSize < 4 || riffEnd > bytes.byteLength || riffEnd < 12)
    throw invalid(
      "stt",
      "transcribe",
      "The WAV RIFF size is invalid.",
      "The WAV audio is invalid.",
    );

  let offset = 12;
  let format:
    | {
        audioFormat: number;
        channels: number;
        sampleRate: number;
        byteRate: number;
        blockAlign: number;
        bitsPerSample: number;
      }
    | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= riffEnd) {
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    const paddedEnd = chunkEnd + (chunkSize % 2);
    if (chunkEnd > riffEnd || paddedEnd > riffEnd || chunkEnd > bytes.byteLength)
      throw invalid(
        "stt",
        "transcribe",
        "The WAV chunk size is invalid.",
        "The WAV audio is invalid.",
      );
    if (ascii(bytes, offset, "fmt ")) {
      if (chunkSize < 16)
        throw invalid(
          "stt",
          "transcribe",
          "The WAV format chunk is incomplete.",
          "The WAV audio is invalid.",
        );
      format = {
        audioFormat: view.getUint16(chunkStart, true),
        channels: view.getUint16(chunkStart + 2, true),
        sampleRate: view.getUint32(chunkStart + 4, true),
        byteRate: view.getUint32(chunkStart + 8, true),
        blockAlign: view.getUint16(chunkStart + 12, true),
        bitsPerSample: view.getUint16(chunkStart + 14, true),
      };
    } else if (ascii(bytes, offset, "data")) {
      if (dataBytes !== undefined)
        throw invalid(
          "stt",
          "transcribe",
          "The WAV contains multiple data chunks.",
          "The WAV audio is invalid.",
        );
      dataBytes = chunkSize;
    }
    offset = paddedEnd;
  }

  if (!format || dataBytes === undefined || dataBytes === 0)
    throw invalid(
      "stt",
      "transcribe",
      "The WAV is missing a PCM format or data chunk.",
      "The WAV audio is invalid.",
    );
  if (
    format.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.bitsPerSample !== 16 ||
    (format.sampleRate !== 16_000 && format.sampleRate !== 24_000) ||
    format.blockAlign !== 2 ||
    format.byteRate !== format.sampleRate * format.blockAlign ||
    dataBytes % format.blockAlign !== 0
  )
    throw invalid(
      "stt",
      "transcribe",
      "Meta requires mono 16-bit PCM WAV audio at 16 kHz or 24 kHz.",
      "The WAV format is not supported.",
    );

  const durationMs = (dataBytes / format.byteRate) * 1000;
  if (durationMs > maxDurationMs || durationMs > maxAudioDurationMs)
    throw invalid(
      "stt",
      "transcribe",
      "The WAV audio exceeds the ten-minute duration limit.",
      "The audio is too long.",
    );
  return { ...format, dataBytes };
}

function audioContentType(contentType: string): boolean {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return normalized === "audio/wav" || normalized === "audio/wave" || normalized === "audio/x-wav";
}

function parseTranscriptResponse(
  value: unknown,
  operation: ProviderOperationContext,
  maxDurationMs: number,
): Transcript {
  const record = asRecord(value, sttContext("transcribe"));
  const text = typeof record.transcript === "string" ? record.transcript : record.text;
  if (typeof text !== "string")
    throw invalid("stt", "transcribe", "Meta transcription response is missing transcript text.");
  if (typeof record.audioDurationMs === "number" && record.audioDurationMs > maxDurationMs)
    throw invalid(
      "stt",
      "transcribe",
      "Meta reported an audio duration over the configured limit.",
      "The audio is too long.",
    );

  const words: TranscriptWord[] = [];
  if (Array.isArray(record.turns)) {
    for (const turn of record.turns) {
      const item = asRecord(turn, sttContext("transcribe"));
      const turnText = item.transcript;
      if (typeof turnText !== "string")
        throw invalid("stt", "transcribe", "Meta transcription turn is missing text.");
      if (turnText.length === 0) continue;
      const startMs = item.startMs;
      const endMs = item.endMs;
      if (
        typeof startMs !== "number" ||
        !Number.isFinite(startMs) ||
        typeof endMs !== "number" ||
        !Number.isFinite(endMs)
      )
        throw invalid("stt", "transcribe", "Meta transcription turn is missing timestamps.");
      words.push({
        text: turnText,
        startMs: Math.round(startMs),
        endMs: Math.round(endMs),
        ...(typeof item.speaker === "string" && item.speaker.length > 0
          ? { speaker: item.speaker }
          : {}),
      });
    }
  }
  const providerOperationId =
    typeof record.sessionId === "string" && record.sessionId.length > 0
      ? record.sessionId
      : operation.operationId;
  return {
    text,
    ...(typeof record.language === "string" && record.language.length > 0
      ? { language: record.language }
      : {}),
    ...(words.length > 0 ? { words } : {}),
    providerOperationId,
  };
}

function imageMetadata() {
  return {
    providerId,
    displayName: "Meta image generation",
    version: "0.1.0",
    configVersion: "1",
    buildDigest: "builtin:meta-image:0.1.0",
    capabilities: [{ key: "generate" }, { key: "base64-output" }, { key: "single-image" }],
    requiredSecrets: [
      { name: "apiKeySecret", description: "Meta Model API key reference", required: true },
    ],
    trusted: true,
  } as const;
}

function sttMetadata() {
  return {
    providerId,
    displayName: "Meta speech-to-text",
    version: "0.1.0",
    configVersion: "1",
    buildDigest: "builtin:meta-stt:0.1.0",
    capabilities: [{ key: "transcribe" }, { key: "wav-input" }, { key: "diarization" }],
    requiredSecrets: [
      { name: "apiKeySecret", description: "Meta Model API key reference", required: true },
    ],
    trusted: true,
  } as const;
}

export function createMetaImageDriver(options: MetaImageDriverOptions = {}): ImageDriver {
  return {
    module: "image",
    providerId,
    metadata: imageMetadata(),
    config: {
      version: "1",
      schema: imageConfigSchema as unknown as ProviderConfigDefinition<ImageConfig>["schema"],
    },
    async create(
      rawConfig: ImageConfig,
      createContext: ProviderCreateContext,
    ): Promise<ImageClient> {
      const config = rawConfig as MetaImageConfig;
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
          assertNotAborted(operation.signal, "image", "generate");
          if (
            typeof request.prompt !== "string" ||
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
              "Meta image references require the edit endpoint and are not supported by this adapter.",
              "Image references are not supported by this provider configuration.",
            );
          const size = imageSize(request);
          const body: Record<string, unknown> = {
            model: request.model ?? config.defaultModel,
            prompt: request.prompt,
            n: 1,
            response_format: "b64_json",
            output_format: config.outputFormat,
          };
          if (size) body.size = size;
          if (jsonByteLength(body) > config.maxRequestBytes)
            throw invalid(
              "image",
              "generate",
              "The image request exceeds its size limit.",
              "The image request is too large.",
            );
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
              (value) => parseImageResponse(value, config, operation),
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

export function createMetaSttDriver(options: MetaSttDriverOptions = {}): SttDriver {
  return {
    module: "stt",
    providerId,
    metadata: sttMetadata(),
    config: {
      version: "1",
      schema: sttConfigSchema as unknown as ProviderConfigDefinition<SttConfig>["schema"],
    },
    async create(rawConfig: SttConfig, createContext: ProviderCreateContext): Promise<SttClient> {
      const config = rawConfig as MetaSttConfig;
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
          assertNotAborted(operation.signal, "stt", "transcribe");
          const audio = await resolveAudio(request, operation, options.resolveReference);
          assertNotAborted(operation.signal, "stt", "transcribe");
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
              `Meta accepts WAV audio only, not ${audio.contentType}.`,
              "Only WAV audio is supported.",
            );
          parseWav(audio.bytes, config.maxDurationMs);
          const requestBody: Record<string, unknown> = {
            model: config.defaultModel,
            audioEncoding: "WAV",
            mode: request.diarize ? "DIARIZATION" : "PUSH_TO_TALK",
          };
          const language = request.language ?? config.defaultLanguage;
          if (language?.trim()) requestBody.languageBias = [language.trim()];
          const requestJson = JSON.stringify(requestBody);
          if (
            new TextEncoder().encode(requestJson).byteLength + audio.bytes.byteLength >
            config.maxRequestBytes
          )
            throw invalid(
              "stt",
              "transcribe",
              "The transcription request exceeds its size limit.",
              "The audio request is too large.",
            );
          const form = new FormData();
          form.append(
            "request",
            new Blob([requestJson], { type: "application/json" }),
            "request.json",
          );
          form.append(
            "audio",
            blobFor(audio.bytes, "audio/wav"),
            audio.fileName?.toLowerCase().endsWith(".wav") ? audio.fileName : "audio.wav",
          );
          try {
            return await http.json(
              {
                method: "POST",
                path: "/asr/transcribe",
                body: form,
                headers: { Accept: "application/json" },
                signal: operation.signal,
                maxResponseBytes: config.maxResponseBytes,
                uncertainOnNetworkFailure: true,
              },
              sttContext("transcribe"),
              (value) => parseTranscriptResponse(value, operation, config.maxDurationMs),
            );
          } catch (error) {
            throw redactError(error, secrets, "stt", "transcribe");
          }
        },
        async close() {},
      };
    },
  };
}

export { imageConfigSchema as metaImageConfigSchema, sttConfigSchema as metaSttConfigSchema };
