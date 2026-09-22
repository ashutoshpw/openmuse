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
  type ProviderConfigDefinition,
  type ProviderOperationContext,
} from "@openmuse/provider-contracts";
import {
  asFiniteNumber,
  asRecord,
  asString,
  createHttpClient,
  type FetchLike,
} from "@openmuse/provider-http";
import { toCompatibleMessages, type ArtifactResolver } from "./messages.js";

export interface OpenAiCompatibleConfig extends ModelConfig {
  endpoint: string;
  apiKeySecret: string;
  organization?: string;
  stream: boolean;
  maxResponseBytes: number;
  maxStreamDurationMs: number;
  requestTimeoutMs: number;
}

export interface OpenAiCompatibleDriverOptions {
  providerId?: string;
  displayName?: string;
  defaultEndpoint?: string;
  defaultModel?: string;
  fetch?: FetchLike;
  artifactResolver?: ArtifactResolver;
}

const configInputSchema = z
  .object({
    endpoint: z.string().url().optional(),
    apiKeySecret: z.string().trim().min(1),
    organization: z.string().trim().min(1).optional(),
    defaultModel: z.string().trim().min(1).optional(),
    stream: z.boolean().default(true),
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

function configSchema(defaultEndpoint: string, defaultModel: string) {
  return configInputSchema.transform((value) => ({
    ...value,
    endpoint: value.endpoint ?? defaultEndpoint,
    defaultModel: value.defaultModel ?? defaultModel,
  }));
}

function context(
  providerId: string,
  operation: string,
): { providerId: string; module: "model"; operation: string } {
  return { providerId, module: "model", operation };
}

function parseJson(value: unknown, providerId: string, operation: string): Record<string, unknown> {
  return asRecord(value, context(providerId, operation));
}

function parseUsage(
  value: unknown,
  providerId: string,
): Extract<ModelEvent, { type: "usage" }> | undefined {
  if (value === undefined || value === null) return undefined;
  const usage = asRecord(value, context(providerId, "usage"));
  const event: Extract<ModelEvent, { type: "usage" }> = { type: "usage" };
  if (usage.prompt_tokens !== undefined)
    event.inputTokens = asFiniteNumber(
      usage.prompt_tokens,
      "prompt_tokens",
      context(providerId, "usage"),
    );
  if (usage.completion_tokens !== undefined)
    event.outputTokens = asFiniteNumber(
      usage.completion_tokens,
      "completion_tokens",
      context(providerId, "usage"),
    );
  if (
    usage.total_tokens !== undefined &&
    event.inputTokens === undefined &&
    event.outputTokens === undefined
  )
    event.outputTokens = asFiniteNumber(
      usage.total_tokens,
      "total_tokens",
      context(providerId, "usage"),
    );
  return event;
}

function finishReason(
  value: unknown,
  providerId: string,
): Extract<ModelEvent, { type: "completed" }>["finishReason"] {
  if (
    value === "stop" ||
    value === "tool_calls" ||
    value === "length" ||
    value === "content_filter"
  )
    return value === "tool_calls" ? "tool_call" : value;
  throw new ProviderOperationError({
    code: "failed",
    message: "Provider returned an invalid finish reason.",
    safeMessage: "The model returned an invalid response.",
    retryable: false,
    uncertain: false,
    providerId,
    module: "model",
    operation: "generate",
  });
}

function parseToolArguments(value: string, providerId: string): Record<string, unknown> {
  if (value.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new ProviderOperationError({
      code: "failed",
      message: error instanceof Error ? error.message : "Invalid tool arguments.",
      safeMessage: "The model returned invalid tool arguments.",
      retryable: false,
      uncertain: false,
      providerId,
      module: "model",
      operation: "generate",
    });
  }
  return asRecord(parsed, context(providerId, "generate"));
}

interface StreamingToolCall {
  callId: string;
  name: string;
  arguments: string;
}

interface StreamingState {
  toolCalls: Map<string, StreamingToolCall>;
  usage?: Extract<ModelEvent, { type: "usage" }>;
}

function responseEvents(
  record: Record<string, unknown>,
  providerId: string,
  streamingState?: StreamingState,
): ModelEvent[] {
  const choices = record.choices;
  if (!Array.isArray(choices))
    throw new ProviderOperationError({
      code: "failed",
      message: "Provider response is missing choices.",
      safeMessage: "The model returned an invalid response.",
      retryable: false,
      uncertain: false,
      providerId,
      module: "model",
      operation: "generate",
    });
  const first =
    choices[0] === undefined ? undefined : asRecord(choices[0], context(providerId, "generate"));
  if (!first) return [];
  const message = first.message
    ? asRecord(first.message, context(providerId, "generate"))
    : undefined;
  const delta = first.delta ? asRecord(first.delta, context(providerId, "generate")) : undefined;
  const content = message?.content ?? delta?.content;
  const events: ModelEvent[] = [];
  if (content !== undefined && content !== null) {
    if (typeof content !== "string")
      throw new ProviderOperationError({
        code: "failed",
        message: "Provider returned a non-text content value.",
        safeMessage: "The model returned an invalid response.",
        retryable: false,
        uncertain: false,
        providerId,
        module: "model",
        operation: "generate",
      });
    if (content) events.push({ type: "text_delta", text: content });
  }
  const reasoning = message?.reasoning_content ?? delta?.reasoning_content;
  if (reasoning !== undefined) {
    if (typeof reasoning !== "string")
      throw new ProviderOperationError({
        code: "failed",
        message: "Provider returned invalid reasoning content.",
        safeMessage: "The model returned an invalid response.",
        retryable: false,
        uncertain: false,
        providerId,
        module: "model",
        operation: "generate",
      });
    if (reasoning) events.push({ type: "reasoning_delta", text: reasoning });
  }
  const toolCalls = message?.tool_calls ?? delta?.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const [index, item] of toolCalls.entries()) {
      const tool = asRecord(item, context(providerId, "generate"));
      const fn = asRecord(tool.function, context(providerId, "generate"));
      if (streamingState) {
        const key = typeof tool.index === "number" ? String(tool.index) : String(index);
        const current = streamingState.toolCalls.get(key) ?? {
          callId: typeof tool.id === "string" ? tool.id : `tool-${key}`,
          name: "",
          arguments: "",
        };
        if (typeof tool.id === "string") current.callId = tool.id;
        if (typeof fn.name === "string") current.name += fn.name;
        if (typeof fn.arguments === "string") current.arguments += fn.arguments;
        else if (fn.arguments !== undefined) current.arguments += JSON.stringify(fn.arguments);
        streamingState.toolCalls.set(key, current);
      } else {
        const callId = asString(tool.id, "tool_call.id", context(providerId, "generate"));
        const name = asString(fn.name, "tool_call.function.name", context(providerId, "generate"));
        const args =
          typeof fn.arguments === "string"
            ? parseToolArguments(fn.arguments, providerId)
            : asRecord(fn.arguments, context(providerId, "generate"));
        events.push({ type: "tool_call", callId, name, arguments: args });
      }
    }
  }
  const usage = parseUsage(record.usage, providerId);
  if (usage) {
    if (streamingState) streamingState.usage = usage;
    else events.push(usage);
  }
  if (first.finish_reason !== undefined && first.finish_reason !== null)
    events.push({ type: "completed", finishReason: finishReason(first.finish_reason, providerId) });
  return events;
}

function errorFromSecret(providerId: string): ProviderOperationError {
  return new ProviderOperationError({
    code: "authentication_required",
    message: "An API key secret resolver is required.",
    safeMessage: "The model provider is not configured.",
    retryable: false,
    uncertain: false,
    providerId,
    module: "model",
    operation: "authenticate",
  });
}

export function createOpenAiCompatibleModelDriver(
  options: OpenAiCompatibleDriverOptions = {},
): ModelDriver {
  const providerId = options.providerId ?? "openai-compatible";
  const displayName = options.displayName ?? "OpenAI-compatible model";
  const defaultEndpoint = options.defaultEndpoint ?? "https://api.openai.com/v1";
  const defaultModel = options.defaultModel ?? "gpt-4o-mini";
  return {
    module: "model",
    providerId,
    metadata: {
      providerId,
      displayName,
      version: "0.1.0",
      configVersion: "1",
      buildDigest: `builtin:${providerId}:0.1.0`,
      capabilities: [{ key: "generate" }, { key: "stream" }, { key: "tools" }, { key: "vision" }],
      requiredSecrets: [
        { name: "apiKeySecret", description: "Provider API key reference", required: true },
      ],
      trusted: true,
    },
    config: {
      version: "1",
      schema: configSchema(
        defaultEndpoint,
        defaultModel,
      ) as unknown as ProviderConfigDefinition<ModelConfig>["schema"],
    },
    async create(
      rawConfig: ModelConfig,
      createContext: ProviderCreateContext,
    ): Promise<ModelClient> {
      const config = rawConfig as OpenAiCompatibleConfig;
      const providerHttp = createHttpClient({
        baseUrl: config.endpoint,
        fetch: options.fetch ?? globalThis.fetch,
        defaultTimeoutMs: config.requestTimeoutMs,
        headers: async () => {
          if (!createContext.secrets) throw errorFromSecret(providerId);
          const apiKey = await createContext.secrets.resolve(
            config.apiKeySecret,
            createContext.signal,
          );
          if (!apiKey) throw errorFromSecret(providerId);
          return {
            Authorization: `Bearer ${apiKey}`,
            ...(config.organization ? { "OpenAI-Organization": config.organization } : {}),
          };
        },
      });
      return {
        async *generate(
          request: ModelGenerateRequest,
          operation: ProviderOperationContext,
        ): AsyncIterable<ModelEvent> {
          const body = {
            model: request.model ?? config.defaultModel,
            messages: await toCompatibleMessages(
              request.messages,
              options.artifactResolver,
              operation,
            ),
            ...(request.tools
              ? {
                  tools: request.tools.map((tool) => ({
                    type: "function",
                    function: {
                      name: tool.name,
                      ...(tool.description ? { description: tool.description } : {}),
                      parameters: tool.inputSchema,
                    },
                  })),
                }
              : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxOutputTokens !== undefined
              ? { max_tokens: request.maxOutputTokens }
              : {}),
            ...(request.responseFormat === "json"
              ? { response_format: { type: "json_object" } }
              : {}),
            stream: config.stream,
          };
          if (!config.stream) {
            const record = await providerHttp.json(
              {
                method: "POST",
                path: "/chat/completions",
                body,
                signal: operation.signal,
                maxResponseBytes: config.maxResponseBytes,
                uncertainOnNetworkFailure: false,
              },
              context(providerId, "generate"),
              (value) => parseJson(value, providerId, "generate"),
            );
            const events = responseEvents(record, providerId);
            if (!events.some((event) => event.type === "completed"))
              throw new ProviderOperationError({
                code: "failed",
                message: "Provider response did not finish.",
                safeMessage: "The model returned an incomplete response.",
                retryable: false,
                uncertain: false,
                providerId,
                module: "model",
                operation: "generate",
              });
            yield* events;
            return;
          }
          const response = await providerHttp.request(
            {
              method: "POST",
              path: "/chat/completions",
              body,
              signal: operation.signal,
              uncertainOnNetworkFailure: false,
            },
            context(providerId, "generate"),
          );
          let completed: Extract<ModelEvent, { type: "completed" }> | undefined;
          const streamingState: StreamingState = { toolCalls: new Map() };
          let sawDone = false;
          for await (const payload of providerHttp.sse(
            response,
            {
              signal: operation.signal,
              maxBytes: config.maxResponseBytes,
              maxDurationMs: config.maxStreamDurationMs,
            },
            context(providerId, "stream"),
          )) {
            if (payload === "[DONE]") {
              sawDone = true;
              break;
            }
            let value: unknown;
            try {
              value = JSON.parse(payload);
            } catch {
              throw new ProviderOperationError({
                code: "failed",
                message: "Provider stream contained invalid JSON.",
                safeMessage: "The model returned an invalid stream.",
                retryable: false,
                uncertain: false,
                providerId,
                module: "model",
                operation: "stream",
              });
            }
            for (const event of responseEvents(
              asRecord(value, context(providerId, "stream")),
              providerId,
              streamingState,
            )) {
              if (event.type === "completed") completed = event;
              else yield event;
            }
          }
          if (!sawDone || !completed)
            throw new ProviderOperationError({
              code: "failed",
              message: "Provider stream ended without a completion marker.",
              safeMessage: "The model returned an incomplete stream.",
              retryable: false,
              uncertain: false,
              providerId,
              module: "model",
              operation: "stream",
            });
          for (const call of streamingState.toolCalls.values()) {
            if (!call.name)
              throw new ProviderOperationError({
                code: "failed",
                message: "Provider tool call omitted a name.",
                safeMessage: "The model returned an invalid tool call.",
                retryable: false,
                uncertain: false,
                providerId,
                module: "model",
                operation: "stream",
              });
            yield {
              type: "tool_call",
              callId: call.callId,
              name: call.name,
              arguments: parseToolArguments(call.arguments, providerId),
            };
          }
          if (streamingState.usage) yield streamingState.usage;
          yield completed;
        },
        async listModels(operation: ProviderOperationContext): Promise<readonly ModelDescriptor[]> {
          const record = await providerHttp.json(
            {
              path: "/models",
              signal: operation.signal,
              maxResponseBytes: config.maxResponseBytes,
            },
            context(providerId, "list_models"),
            (value) => parseJson(value, providerId, "list_models"),
          );
          if (!Array.isArray(record.data))
            throw new ProviderOperationError({
              code: "failed",
              message: "Provider model list is invalid.",
              safeMessage: "The model provider returned an invalid model list.",
              retryable: false,
              uncertain: false,
              providerId,
              module: "model",
              operation: "list_models",
            });
          return record.data.map((value) => {
            const item = asRecord(value, context(providerId, "list_models"));
            const descriptor: ModelDescriptor = {
              id: asString(item.id, "id", context(providerId, "list_models")),
              capabilities: ["text"],
            };
            if (typeof item.name === "string") descriptor.displayName = item.name;
            return descriptor;
          });
        },
        async close() {},
      };
    },
  };
}

export const openAiCompatibleConfigSchema = configSchema(
  "https://api.openai.com/v1",
  "gpt-4o-mini",
);
export type { ArtifactResolver } from "./messages.js";
