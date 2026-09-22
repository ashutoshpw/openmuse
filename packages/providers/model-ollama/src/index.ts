import { z } from "zod";
import {
  ProviderOperationError,
  type ModelClient,
  type ModelConfig,
  type ModelDescriptor,
  type ModelDriver,
  type ModelEvent,
  type ModelGenerateRequest,
  type ProviderCreateContext,
  type ProviderOperationContext,
} from "@openmuse/provider-contracts";
import {
  asFiniteNumber,
  asRecord,
  asString,
  createHttpClient,
  toBase64,
  type FetchLike,
} from "@openmuse/provider-http";
import type { ArtifactResolver } from "@openmuse/provider-model-openai-compatible";

export interface OllamaConfig extends ModelConfig {
  endpoint: string;
  keepAlive: string;
  stream: boolean;
  maxResponseBytes: number;
  maxStreamDurationMs: number;
  requestTimeoutMs: number;
}

export interface OllamaDriverOptions {
  fetch?: FetchLike;
  artifactResolver?: ArtifactResolver;
}

const configSchema = z
  .object({
    endpoint: z.string().url().default("http://127.0.0.1:11434"),
    defaultModel: z.string().trim().min(1).default("llama3.2"),
    keepAlive: z.string().trim().min(1).default("5m"),
    stream: z.literal(true).default(true),
    maxResponseBytes: z
      .number()
      .int()
      .min(16 * 1024)
      .max(50 * 1024 * 1024)
      .default(5 * 1024 * 1024),
    maxStreamDurationMs: z
      .number()
      .int()
      .min(1000)
      .max(15 * 60 * 1000)
      .default(120_000),
    requestTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(15 * 60 * 1000)
      .default(120_000),
  })
  .strict();

function context(providerId: string, operation: string) {
  return { providerId, module: "model" as const, operation };
}

function invalid(providerId: string, message: string): ProviderOperationError {
  return new ProviderOperationError({
    code: "failed",
    message,
    safeMessage: "Ollama returned an invalid response.",
    retryable: false,
    uncertain: false,
    providerId,
    module: "model",
    operation: "stream",
  });
}

async function toOllamaMessages(
  messages: ModelGenerateRequest["messages"],
  resolver: ArtifactResolver | undefined,
  operation: ProviderOperationContext,
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(
    messages.map(async (message) => {
      const text: string[] = [];
      const images: string[] = [];
      const toolCalls: unknown[] = [];
      for (const part of message.parts) {
        if (part.type === "text" || part.type === "reasoning") text.push(part.text);
        else if (part.type === "approvalRef") text.push(`[approval:${part.approvalId}]`);
        else if (part.type === "citation") text.push(`[citation:${part.title ?? part.url}]`);
        else if (part.type === "toolCall")
          toolCalls.push({
            function: { name: part.name, arguments: part.arguments },
            ...(part.callId ? { id: part.callId } : {}),
          });
        else if (part.type === "toolResult")
          text.push(
            part.ok
              ? JSON.stringify(part.result ?? null)
              : JSON.stringify({ error: part.error ?? "tool failed" }),
          );
        else {
          if (!("artifactId" in part))
            throw invalid("ollama", "This model adapter only accepts artifact-backed media parts.");
          if (!resolver)
            throw invalid(
              "ollama",
              `Artifact ${"artifactId" in part ? part.artifactId : "unknown"} requires an artifact resolver.`,
            );
          const artifact = await resolver.resolve(part.artifactId, operation);
          if (!artifact.bytes)
            throw invalid("ollama", "Ollama media input requires artifact bytes.");
          if (artifact.bytes.byteLength > 20 * 1024 * 1024)
            throw invalid("ollama", "Artifact exceeds the model input size limit.");
          if (part.type === "image") images.push(toBase64(artifact.bytes));
          else text.push(`[artifact:${part.artifactId}]`);
        }
      }
      return {
        role: message.role,
        content: text.join("\n"),
        ...(images.length > 0 ? { images } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      };
    }),
  );
}

function parseToolCalls(value: unknown, providerId: string): ModelEvent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(providerId, "Ollama returned invalid tool calls.");
  return value.map((item, index) => {
    const tool = asRecord(item, context(providerId, "stream"));
    const fn = asRecord(tool.function, context(providerId, "stream"));
    const name = asString(fn.name, "tool_calls.function.name", context(providerId, "stream"));
    const args =
      typeof fn.arguments === "string" ? (JSON.parse(fn.arguments) as unknown) : fn.arguments;
    return {
      type: "tool_call",
      callId: typeof tool.id === "string" ? tool.id : `ollama-tool-${index}`,
      name,
      arguments: asRecord(args, context(providerId, "stream")),
    };
  });
}

export function createOllamaModelDriver(options: OllamaDriverOptions = {}): ModelDriver {
  const providerId = "ollama";
  return {
    module: "model",
    providerId,
    metadata: {
      providerId,
      displayName: "Ollama local model",
      version: "0.1.0",
      configVersion: "1",
      buildDigest: "builtin:ollama:0.1.0",
      capabilities: [{ key: "generate" }, { key: "stream" }, { key: "tools" }, { key: "vision" }],
      requiredSecrets: [],
      trusted: true,
    },
    config: { version: "1", schema: configSchema },
    async create(
      rawConfig: ModelConfig,
      createContext: ProviderCreateContext,
    ): Promise<ModelClient> {
      const config = rawConfig as OllamaConfig;
      const http = createHttpClient({
        baseUrl: config.endpoint,
        fetch: options.fetch ?? globalThis.fetch,
        defaultTimeoutMs: config.requestTimeoutMs,
      });
      return {
        async *generate(
          request: ModelGenerateRequest,
          operation: ProviderOperationContext,
        ): AsyncIterable<ModelEvent> {
          const response = await http.request(
            {
              method: "POST",
              path: "/api/chat",
              body: {
                model: request.model ?? config.defaultModel,
                messages: await toOllamaMessages(
                  request.messages,
                  options.artifactResolver,
                  operation,
                ),
                ...(request.tools ? { tools: request.tools } : {}),
                options: {
                  ...(request.temperature !== undefined
                    ? { temperature: request.temperature }
                    : {}),
                  ...(request.maxOutputTokens !== undefined
                    ? { num_predict: request.maxOutputTokens }
                    : {}),
                },
                keep_alive: config.keepAlive,
                stream: true,
              },
              signal: operation.signal,
            },
            context(providerId, "generate"),
          );
          let done = false;
          for await (const payload of http.ndjson(
            response,
            {
              signal: operation.signal,
              maxBytes: config.maxResponseBytes,
              maxDurationMs: config.maxStreamDurationMs,
            },
            context(providerId, "stream"),
          )) {
            let value: unknown;
            try {
              value = JSON.parse(payload);
            } catch {
              throw invalid(providerId, "Ollama stream contained invalid JSON.");
            }
            const record = asRecord(value, context(providerId, "stream"));
            const message = record.message
              ? asRecord(record.message, context(providerId, "stream"))
              : undefined;
            if (message?.content !== undefined) {
              if (typeof message.content !== "string")
                throw invalid(providerId, "Ollama message content is invalid.");
              if (message.content) yield { type: "text_delta", text: message.content };
            }
            if (message?.thinking !== undefined) {
              if (typeof message.thinking !== "string")
                throw invalid(providerId, "Ollama reasoning content is invalid.");
              if (message.thinking) yield { type: "reasoning_delta", text: message.thinking };
            }
            for (const event of parseToolCalls(message?.tool_calls, providerId)) yield event;
            if (record.done === true) {
              done = true;
              if (record.prompt_eval_count !== undefined || record.eval_count !== undefined)
                yield {
                  type: "usage",
                  ...(record.prompt_eval_count !== undefined
                    ? {
                        inputTokens: asFiniteNumber(
                          record.prompt_eval_count,
                          "prompt_eval_count",
                          context(providerId, "stream"),
                        ),
                      }
                    : {}),
                  ...(record.eval_count !== undefined
                    ? {
                        outputTokens: asFiniteNumber(
                          record.eval_count,
                          "eval_count",
                          context(providerId, "stream"),
                        ),
                      }
                    : {}),
                };
              const reason = record.done_reason;
              yield {
                type: "completed",
                finishReason:
                  reason === "length" ? "length" : reason === "tool" ? "tool_call" : "stop",
              };
            }
          }
          if (!done) throw invalid(providerId, "Ollama stream ended without a done marker.");
        },
        async listModels(operation: ProviderOperationContext): Promise<readonly ModelDescriptor[]> {
          const record = await http.json(
            { path: "/api/tags", signal: operation.signal },
            context(providerId, "list_models"),
            (value) => asRecord(value, context(providerId, "list_models")),
          );
          if (!Array.isArray(record.models))
            throw invalid(providerId, "Ollama model list is invalid.");
          return record.models.map((value) => {
            const model = asRecord(value, context(providerId, "list_models"));
            return {
              id: asString(model.name, "models.name", context(providerId, "list_models")),
              capabilities: ["text"] as const,
            };
          });
        },
        async close() {
          void createContext;
        },
      };
    },
  };
}

export { configSchema as ollamaConfigSchema };
