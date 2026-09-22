import { describe, expect, it } from "vitest";
import { createMetaModelDriver } from "../src/index.js";

describe("Meta model adapter", () => {
  it("pins the Meta compatibility endpoint and provider identity", () => {
    const driver = createMetaModelDriver({ fetch: async () => new Response("{}") });
    expect(driver.providerId).toBe("meta-llama");
    expect(driver.config.schema.parse({ apiKeySecret: "meta-key" })).toMatchObject({
      endpoint: "https://api.llama.com/compat/v1",
    });
  });
});
