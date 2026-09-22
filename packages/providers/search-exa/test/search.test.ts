import { describe, expect, it } from "vitest";
import { createExaSearchDriver } from "../src/index.js";

describe("Exa search adapter", () => {
  it("normalizes highlights and provenance", async () => {
    const driver = createExaSearchDriver({
      fetch: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Example",
                url: "https://example.test",
                highlights: ["one", "two"],
                publishedDate: "2026-01-01",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    const client = await driver.create(
      driver.config.schema.parse({ endpoint: "https://exa.test", apiKeySecret: "exa-key" }),
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
    expect(result.results[0]).toMatchObject({
      title: "Example",
      snippet: "one\ntwo",
      source: "exa",
    });
    expect(result.results[0]?.contentHash).toHaveLength(64);
  });

  it("rejects a schema mismatch instead of returning an empty success", async () => {
    const driver = createExaSearchDriver({
      fetch: async () =>
        new Response(JSON.stringify({ items: [] }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const client = await driver.create(
      driver.config.schema.parse({ endpoint: "https://exa.test", apiKeySecret: "exa-key" }),
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
    ).rejects.toMatchObject({ code: "failed" });
  });
});
