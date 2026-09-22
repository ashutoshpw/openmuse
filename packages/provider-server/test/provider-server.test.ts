import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OpenMuseDatabase } from "@openmuse/db";
import {
  WorkerProviderRuntime,
  createBuiltinProviderCatalog,
  createBuiltinProviderRegistry,
  decryptCredentialEnvelope,
  encryptCredentialEnvelope,
} from "../src/index.js";
import type { ModelClient } from "@openmuse/provider-contracts";

function key(): string {
  return randomBytes(32).toString("base64url");
}

describe("provider server composition", () => {
  it("encrypts credentials with tenant, instance, secret, and revision AAD", () => {
    const encodedKey = key();
    const aad = {
      workspaceId: "workspace-a",
      actorId: "user-a",
      providerInstanceId: "instance-a",
      secretName: "apiKey",
      revision: 1,
    } as const;
    const envelope = encryptCredentialEnvelope("secret-value", encodedKey, aad);

    expect(decryptCredentialEnvelope(envelope, encodedKey, aad)).toBe("secret-value");
    expect(() =>
      decryptCredentialEnvelope(envelope, encodedKey, { ...aad, revision: 2 }),
    ).toThrow();
    expect(() =>
      decryptCredentialEnvelope(envelope, encodedKey, { ...aad, workspaceId: "workspace-b" }),
    ).toThrow();
  });

  it("rejects untrusted provider endpoints at the server catalogue boundary", () => {
    const catalog = createBuiltinProviderCatalog({
      trustedEndpoints: ["https://operator.example/providers"],
    });

    expect(() =>
      catalog.normalizeConfig("model", "openai-compatible", {
        endpoint: "https://attacker.example/v1",
        apiKeySecret: "credential-id",
      }),
    ).toThrow("not trusted");
    expect(
      catalog.normalizeConfig("model", "openai-compatible", {
        endpoint: "https://operator.example/providers/openai",
        apiKeySecret: "credential-id",
      }),
    ).toMatchObject({ endpoint: "https://operator.example/providers/openai" });
  });

  it("executes the registered deterministic provider fixture", async () => {
    const registry = createBuiltinProviderRegistry({
      deterministic: true,
      deterministicResponse: "ok",
    });
    const scope = registry.createScope({ signal: new AbortController().signal });
    const client = await scope.resolve<ModelClient>(
      "fixture-instance",
      "model",
      "deterministic",
      {},
      { configDigest: "builtin:deterministic:1" },
    );
    const events = [];
    for await (const event of client.generate(
      { messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }] },
      {
        signal: new AbortController().signal,
        operationId: "operation-a",
      },
    )) {
      events.push(event);
    }
    await scope.close("test complete");
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      { type: "usage", inputTokens: 1, outputTokens: 2 },
      { type: "completed", finishReason: "stop" },
    ]);
  });

  it("allows deterministic worker mode only in tests", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    expect(
      () =>
        new WorkerProviderRuntime({
          db: {} as OpenMuseDatabase,
          deterministic: true,
        }),
    ).toThrow("test-only");
    process.env.NODE_ENV = original;
  });
});
