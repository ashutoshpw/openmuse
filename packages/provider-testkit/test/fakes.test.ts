import { describe, expect, it } from "vitest";
import { assertProviderRegistration, collectAsync, createFakeModelDriver } from "../src/index.js";

describe("provider testkit", () => {
  it("provides deterministic model events", async () => {
    const driver = createFakeModelDriver();
    assertProviderRegistration(driver);
    const client = await driver.create(
      { defaultModel: "fake-model" },
      {
        signal: new AbortController().signal,
        scopeId: "test-scope",
      },
    );
    await expect(
      collectAsync(
        client.generate(
          { messages: [] },
          {
            signal: new AbortController().signal,
            operationId: "operation-1",
          },
        ),
      ),
    ).resolves.toEqual([
      { type: "text_delta", text: "deterministic response" },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "completed", finishReason: "stop" },
    ]);
    await client.close();
  });
});
