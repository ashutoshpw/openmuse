import { z } from "zod";
import {
  type ProviderCreateContext,
  type ProviderOperationContext,
  type SearchClient,
  type SearchConfig,
  type SearchDriver,
  type SearchRequest,
  type SearchResponse,
} from "@openmuse/provider-contracts";
import {
  asRecord,
  asString,
  createHttpClient,
  sha256Hex,
  type FetchLike,
} from "@openmuse/provider-http";

export interface TavilyConfig extends SearchConfig {
  endpoint: string;
  apiKeySecret: string;
  maxResponseBytes: number;
  requestTimeoutMs: number;
}

export interface TavilyDriverOptions {
  fetch?: FetchLike;
}

const configSchema = z
  .object({
    endpoint: z.string().url().default("https://api.tavily.com"),
    apiKeySecret: z.string().trim().min(1),
    defaultIndex: z.string().trim().min(1).default("advanced"),
    maxResponseBytes: z
      .number()
      .int()
      .min(16 * 1024)
      .max(20 * 1024 * 1024)
      .default(5 * 1024 * 1024),
    requestTimeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
  })
  .strict();

function context(operation: string) {
  return { providerId: "tavily", module: "search" as const, operation };
}

function secretError() {
  return new Error("A secret resolver is required for Tavily.");
}

async function normalizeResults(
  value: unknown,
  request: SearchRequest,
  operation: ProviderOperationContext,
): Promise<SearchResponse> {
  const record = asRecord(value, context("search"));
  if (!Array.isArray(record.results)) throw new Error("Tavily response is missing results.");
  const results = await Promise.all(
    record.results.map(async (item) => {
      const result = asRecord(item, context("search"));
      const title = asString(result.title, "results.title", context("search"));
      const url = asString(result.url, "results.url", context("search"));
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("Tavily returned a non-http URL.");
      const snippet =
        typeof result.content === "string" ? result.content.slice(0, 20_000) : undefined;
      const publishedAt =
        typeof result.published_date === "string" ? result.published_date : undefined;
      const contentHash = await sha256Hex(JSON.stringify({ title, url, snippet, publishedAt }));
      return {
        id: contentHash.slice(0, 32),
        title,
        url,
        ...(snippet ? { snippet } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        source: "tavily",
        contentHash,
      };
    }),
  );
  return {
    results,
    ...(typeof record.next_cursor === "string" ? { nextCursor: record.next_cursor } : {}),
    searchedAt: new Date().toISOString(),
    providerOperationId: operation.operationId,
  };
}

export function createTavilySearchDriver(options: TavilyDriverOptions = {}): SearchDriver {
  return {
    module: "search",
    providerId: "tavily",
    metadata: {
      providerId: "tavily",
      displayName: "Tavily search",
      version: "0.1.0",
      configVersion: "1",
      buildDigest: "builtin:tavily:0.1.0",
      capabilities: [{ key: "search" }, { key: "pagination" }, { key: "provenance" }],
      requiredSecrets: [
        { name: "apiKeySecret", description: "Tavily API key reference", required: true },
      ],
      trusted: true,
    },
    config: { version: "1", schema: configSchema },
    async create(
      rawConfig: SearchConfig,
      createContext: ProviderCreateContext,
    ): Promise<SearchClient> {
      const config = rawConfig as TavilyConfig;
      const http = createHttpClient({
        baseUrl: config.endpoint,
        fetch: options.fetch ?? globalThis.fetch,
        defaultTimeoutMs: config.requestTimeoutMs,
        headers: async () => {
          if (!createContext.secrets) throw secretError();
          const apiKey = await createContext.secrets.resolve(
            config.apiKeySecret,
            createContext.signal,
          );
          if (!apiKey) throw secretError();
          return { "Content-Type": "application/json" };
        },
      });
      return {
        async search(
          request: SearchRequest,
          operation: ProviderOperationContext,
        ): Promise<SearchResponse> {
          const apiKey = await createContext.secrets?.resolve(
            config.apiKeySecret,
            operation.signal,
          );
          if (!apiKey) throw secretError();
          return http.json(
            {
              method: "POST",
              path: "/search",
              body: {
                api_key: apiKey,
                query: request.query,
                search_depth: config.defaultIndex,
                max_results: Math.min(request.limit ?? 10, 20),
                include_answer: false,
                include_raw_content: false,
                ...(request.domains?.length ? { include_domains: request.domains } : {}),
                ...(request.cursor ? { cursor: request.cursor } : {}),
              },
              signal: operation.signal,
              maxResponseBytes: config.maxResponseBytes,
            },
            context("search"),
            (value) => normalizeResults(value, request, operation),
          );
        },
        async close() {},
      };
    },
  };
}

export { configSchema as tavilyConfigSchema };
