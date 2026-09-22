import { describe, expect, it } from "vitest";
import { createMetaModelDriver } from "../src/index.js";

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

const operation = { signal: new AbortController().signal, operationId: "operation-1" };

describe("Meta model adapter", () => {
  it("uses the documented Model API endpoint and Muse Spark default", () => {
    const driver = createMetaModelDriver({ fetch: async () => new Response("{}") });
    expect(driver.providerId).toBe("meta-llama");
    expect(driver.config.schema.parse({ apiKeySecret: "meta-key" })).toMatchObject({
      endpoint: "https://api.meta.ai/v1",
      defaultModel: "muse-spark-1.3",
    });
  });

  it("preserves explicitly configured endpoint and model", () => {
    const driver = createMetaModelDriver({ fetch: async () => new Response("{}") });
    expect(
      driver.config.schema.parse({
        apiKeySecret: "meta-key",
        endpoint: "https://self-hosted.example/v1",
        defaultModel: "custom-model",
      }),
    ).toMatchObject({
      endpoint: "https://self-hosted.example/v1",
      defaultModel: "custom-model",
    });
  });

  // Request shape follows https://ai.developer.meta.com/docs/tool-calling.
  it("sends Meta's documented Chat Completions body without internal tool fields", async () => {
    let requestUrl = "";
    let requestBody: unknown;
    const driver = createMetaModelDriver({
      fetch: async (input, init = {}) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1,
            model: "muse-spark-1.3",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ready" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const client = await driver.create(
      driver.config.schema.parse({ apiKeySecret: "meta-key", stream: false }),
      {
        ...operation,
        scopeId: "scope-1",
        secrets: { resolve: async () => "meta-secret" },
      },
    );

    await collect(
      client.generate(
        {
          messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
          tools: [
            {
              name: "lookup_weather",
              description: "Look up the weather.",
              inputSchema: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          ],
        },
        operation,
      ),
    );

    expect(requestUrl).toBe("https://api.meta.ai/v1/chat/completions");
    expect(requestBody).toEqual({
      model: "muse-spark-1.3",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            description: "Look up the weather.",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      stream: false,
    });
    expect(JSON.stringify(requestBody)).not.toContain("inputSchema");
  });
});
