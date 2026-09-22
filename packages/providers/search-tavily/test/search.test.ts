import { describe, expect, it } from "vitest";
import { createTavilySearchDriver } from "../src/index.js";

describe("Tavily search adapter", () => {
  it("normalizes result provenance and never treats an auth response as data", async () => {
    const driver = createTavilySearchDriver({
      fetch: async () =>
        new Response(
          JSON.stringify({
            results: [{ title: "Example", url: "https://example.test", content: "snippet" }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    const client = await driver.create(
      driver.config.schema.parse({
        endpoint: "https://tavily.test",
        apiKeySecret: "tavily-key",
        defaultIndex: "advanced",
        maxResponseBytes: 100_000,
        requestTimeoutMs: 10_000,
      }),
      {
        signal: new AbortController().signal,
        scopeId: "scope",
        secrets: { resolve: async () => "secret" },
      },
    );
    const result = await client.search(
      { query: "example" },
      { signal: new AbortController().signal, operationId: "search-1" },
    );
    expect(result.results[0]).toMatchObject({ title: "Example", source: "tavily" });
    expect(result.results[0]?.contentHash).toHaveLength(64);
  });

  it("surfaces provider auth errors", async () => {
    const driver = createTavilySearchDriver({
      fetch: async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    const client = await driver.create(
      driver.config.schema.parse({
        endpoint: "https://tavily.test",
        apiKeySecret: "tavily-key",
        defaultIndex: "advanced",
        maxResponseBytes: 100_000,
        requestTimeoutMs: 10_000,
      }),
      {
        signal: new AbortController().signal,
        scopeId: "scope",
        secrets: { resolve: async () => "secret" },
      },
    );
    await expect(
      client.search(
        { query: "example" },
        { signal: new AbortController().signal, operationId: "search-1" },
      ),
    ).rejects.toMatchObject({ code: "authentication_required" });
  });
});
