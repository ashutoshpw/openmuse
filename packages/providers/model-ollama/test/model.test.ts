import { describe, expect, it } from "vitest";
import { createOllamaModelDriver } from "../src/index.js";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

describe("Ollama model adapter", () => {
  it("normalizes NDJSON output and rejects an incomplete stream", async () => {
    const driver = createOllamaModelDriver({
      fetch: async () =>
        new Response(
          [
            JSON.stringify({ message: { content: "hello" }, done: false }),
            JSON.stringify({
              message: {},
              done: true,
              done_reason: "stop",
              prompt_eval_count: 1,
              eval_count: 2,
            }),
          ].join("\n"),
          { headers: { "content-type": "application/x-ndjson" } },
        ),
    });
    const client = await driver.create(
      driver.config.schema.parse({
        endpoint: "http://ollama.test",
        defaultModel: "llama",
        keepAlive: "5m",
        stream: true,
        maxResponseBytes: 100_000,
        maxStreamDurationMs: 10_000,
        requestTimeoutMs: 10_000,
      }),
      { signal: new AbortController().signal, scopeId: "scope" },
    );
    await expect(
      collect(
        client.generate(
          { messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] },
          { signal: new AbortController().signal, operationId: "op" },
        ),
      ),
    ).resolves.toEqual([
      { type: "text_delta", text: "hello" },
      { type: "usage", inputTokens: 1, outputTokens: 2 },
      { type: "completed", finishReason: "stop" },
    ]);
  });
});
