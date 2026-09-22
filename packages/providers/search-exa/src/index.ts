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

export interface ExaConfig extends SearchConfig {
  endpoint: string;
  apiKeySecret: string;
  maxResponseBytes: number;
  requestTimeoutMs: number;
}

export interface ExaDriverOptions {
  fetch?: FetchLike;
}

const configSchema = z
  .object({
    endpoint: z.string().url().default("https://api.exa.ai"),
    apiKeySecret: z.string().trim().min(1),
    defaultIndex: z.string().trim().min(1).default("auto"),
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
  return { providerId: "exa", module: "search" as const, operation };
}

async function normalizeResults(
  value: unknown,
  operation: ProviderOperationContext,
): Promise<SearchResponse> {
  const record = asRecord(value, context("search"));
  if (!Array.isArray(record.results)) throw new Error("Exa response is missing results.");
  const results = await Promise.all(
    record.results.map(async (item) => {
      const result = asRecord(item, context("search"));
      const title = asString(result.title, "results.title", context("search"));
      const url = asString(result.url, "results.url", context("search"));
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("Exa returned a non-http URL.");
      const highlights = Array.isArray(result.highlights)
        ? result.highlights.filter((entry): entry is string => typeof entry === "string")
        : [];
      const snippet =
        highlights.join("\n").slice(0, 20_000) ||
        (typeof result.text === "string" ? result.text.slice(0, 20_000) : undefined);
      const publishedAt =
        typeof result.publishedDate === "string" ? result.publishedDate : undefined;
      const contentHash = await sha256Hex(JSON.stringify({ title, url, snippet, publishedAt }));
      return {
        id: contentHash.slice(0, 32),
        title,
        url,
        ...(snippet ? { snippet } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        source: "exa",
        contentHash,
      };
    }),
  );
  return {
    results,
    ...(typeof record.nextPageToken === "string" ? { nextCursor: record.nextPageToken } : {}),
    searchedAt: new Date().toISOString(),
    providerOperationId: operation.operationId,
  };
}

export function createExaSearchDriver(options: ExaDriverOptions = {}): SearchDriver {
  return {
    module: "search",
    providerId: "exa",
    metadata: {
      providerId: "exa",
      displayName: "Exa search",
      version: "0.1.0",
      configVersion: "1",
      buildDigest: "builtin:exa:0.1.0",
      capabilities: [{ key: "search" }, { key: "pagination" }, { key: "provenance" }],
      requiredSecrets: [
        { name: "apiKeySecret", description: "Exa API key reference", required: true },
      ],
      trusted: true,
    },
    config: { version: "1", schema: configSchema },
    async create(
      rawConfig: SearchConfig,
      createContext: ProviderCreateContext,
    ): Promise<SearchClient> {
      const config = rawConfig as ExaConfig;
      const http = createHttpClient({
        baseUrl: config.endpoint,
        fetch: options.fetch ?? globalThis.fetch,
        defaultTimeoutMs: config.requestTimeoutMs,
        headers: async () => {
          const apiKey = await createContext.secrets?.resolve(
            config.apiKeySecret,
            createContext.signal,
          );
          if (!apiKey) throw new Error("A secret resolver is required for Exa.");
          return { "x-api-key": apiKey, "Content-Type": "application/json" };
        },
      });
      return {
        async search(
          request: SearchRequest,
          operation: ProviderOperationContext,
        ): Promise<SearchResponse> {
          return http.json(
            {
              method: "POST",
              path: "/search",
              body: {
                query: request.query,
                type: config.defaultIndex,
                numResults: Math.min(request.limit ?? 10, 100),
                contents: { highlights: true },
                ...(request.domains?.length ? { includeDomains: request.domains } : {}),
                ...(request.cursor ? { nextPageToken: request.cursor } : {}),
              },
              signal: operation.signal,
              maxResponseBytes: config.maxResponseBytes,
            },
            context("search"),
            (value) => normalizeResults(value, operation),
          );
        },
        async close() {},
      };
    },
  };
}

export { configSchema as exaConfigSchema };
