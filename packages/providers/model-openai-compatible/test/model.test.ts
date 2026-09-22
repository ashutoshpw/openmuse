import { describe, expect, it } from "vitest";
import { createOpenAiCompatibleModelDriver } from "../src/index.js";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

const context = { signal: new AbortController().signal, operationId: "op-1" };

describe("OpenAI-compatible model adapter", () => {
  it("normalizes streamed text, tool calls, usage, and completion", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const driver = createOpenAiCompatibleModelDriver({
      fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
    });
    const client = await driver.create(
      driver.config.schema.parse({
        apiKeySecret: "secret-ref",
        stream: true,
        endpoint: "https://provider.test/v1",
        maxResponseBytes: 100_000,
        maxStreamDurationMs: 10_000,
        requestTimeoutMs: 10_000,
        defaultModel: "test",
      }),
      { ...context, scopeId: "scope", secrets: { resolve: async () => "test-key" } },
    );
    await expect(
      collect(
        client.generate(
          { messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }] },
          context,
        ),
      ),
    ).resolves.toEqual([
      { type: "text_delta", text: "hello" },
      { type: "tool_call", callId: "call-1", name: "lookup", arguments: {} },
      { type: "usage", inputTokens: 2, outputTokens: 3 },
      { type: "completed", finishReason: "tool_call" },
    ]);
  });

  it("fails closed when an artifact resolver is absent", async () => {
    const driver = createOpenAiCompatibleModelDriver({ fetch: async () => new Response("unused") });
    const client = await driver.create(
      driver.config.schema.parse({
        apiKeySecret: "secret-ref",
        stream: false,
        endpoint: "https://provider.test/v1",
        maxResponseBytes: 100_000,
        maxStreamDurationMs: 10_000,
        requestTimeoutMs: 10_000,
        defaultModel: "test",
      }),
      { ...context, scopeId: "scope", secrets: { resolve: async () => "test-key" } },
    );
    await expect(
      collect(
        client.generate(
          { messages: [{ role: "user", parts: [{ type: "image", artifactId: "artifact-1" }] }] },
          context,
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
