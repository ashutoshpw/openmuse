import { describe, expect, it } from "vitest";
import type {
  ImageDriver,
  ProviderCreateContext,
  ProviderOperationContext,
  SttDriver,
  TtsDriver,
  TtsSynthesizeRequest,
} from "@openmuse/provider-contracts";
import {
  createOpenAiImageDriver,
  createOpenAiSttDriver,
  createOpenAiTtsDriver,
} from "../src/index.js";

const secret = "openai-review-secret";

function createContext(signal = new AbortController().signal): ProviderCreateContext {
  return {
    signal,
    scopeId: "review-scope",
    workspaceId: "workspace-1",
    tenantId: "tenant-1",
    userId: "user-1",
    secrets: { resolve: async () => secret },
  };
}

function operation(signal = new AbortController().signal): ProviderOperationContext {
  return {
    signal,
    operationId: "review-operation",
    workspaceId: "workspace-1",
    tenantId: "tenant-1",
    userId: "user-1",
  };
}

function imageConfig(driver: ImageDriver, overrides: Record<string, unknown> = {}) {
  return driver.config.schema.parse({
    endpoint: "https://api.openai.test/v1",
    apiKeySecret: "openai-key",
    ...overrides,
  });
}

function sttConfig(driver: SttDriver, overrides: Record<string, unknown> = {}) {
  return driver.config.schema.parse({
    endpoint: "https://api.openai.test/v1",
    apiKeySecret: "openai-key",
    ...overrides,
  });
}

function ttsConfig(driver: TtsDriver, overrides: Record<string, unknown> = {}) {
  return driver.config.schema.parse({
    endpoint: "https://api.openai.test/v1",
    apiKeySecret: "openai-key",
    ...overrides,
  });
}

type StreamProbe = {
  response: Response;
  pulls: () => number;
  cancelled: () => boolean;
  release: () => void;
  started: Promise<void>;
};

function streamProbe(
  body: Uint8Array,
  contentType: string,
  secondPull: "close" | "hang",
): StreamProbe {
  let pullCount = 0;
  let didCancel = false;
  let releasePull: (() => void) | undefined;
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    pull(value) {
      pullCount += 1;
      if (pullCount === 1) {
        value.enqueue(body);
        return;
      }
      resolveStarted?.();
      if (secondPull === "close") {
        value.close();
        return;
      }
      return new Promise<void>((resolve) => {
        releasePull = () => {
          value.close();
          resolve();
        };
      });
    },
    cancel() {
      didCancel = true;
      releasePull?.();
    },
  });
  return {
    response: new Response(stream, { headers: { "content-type": contentType } }),
    pulls: () => pullCount,
    cancelled: () => didCancel,
    release: () => releasePull?.(),
    started,
  };
}

type Settled<T> =
  | { kind: "resolved"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "timeout" };

async function settleWithin<T>(promise: Promise<T>, milliseconds = 250): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), milliseconds);
    promise.then(
      (value) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve({ kind: "resolved", value });
      },
      (error: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve({ kind: "rejected", error });
      },
    );
  });
}

async function settleAfterRelease<T>(promise: Promise<T>, release: () => void): Promise<void> {
  release();
  await promise.catch(() => undefined);
}

describe("OpenAI independent media regressions", () => {
  it("rejects non-audio STT content types before a paid request", async () => {
    let calls = 0;
    const driver = createOpenAiSttDriver({
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ text: "unexpected" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const client = await driver.create(sttConfig(driver), createContext());

    await expect(
      client.transcribe(
        { audio: { bytes: new Uint8Array([1, 2, 3]), contentType: "text/plain" } },
        operation(),
      ),
    ).rejects.toMatchObject({ code: "failed" });
    expect(calls).toBe(0);
  });

  it("rejects a runtime TTS format outside the contract before a paid request", async () => {
    let calls = 0;
    const driver = createOpenAiTtsDriver({
      fetch: async () => {
        calls += 1;
        return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/ogg" } });
      },
    });
    const client = await driver.create(ttsConfig(driver), createContext());

    const request = { text: "Read this", format: "ogg" } as unknown as TtsSynthesizeRequest;
    await expect(client.synthesize(request, operation())).rejects.toMatchObject({ code: "failed" });
    expect(calls).toBe(0);
  });

  it("rejects noncanonical base64 instead of accepting atob's permissive decoding", async () => {
    const driver = createOpenAiImageDriver({
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ b64_json: "AQI" }] }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const client = await driver.create(imageConfig(driver), createContext());

    await expect(client.generate({ prompt: "image" }, operation())).rejects.toMatchObject({
      code: "failed",
    });
  });

  it("redacts the resolved API key from OpenAI provider errors", async () => {
    const driver = createOpenAiImageDriver({
      fetch: async () =>
        new Response(JSON.stringify({ message: `upstream leaked ${secret}` }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    });
    const client = await driver.create(imageConfig(driver), createContext());

    const error = await client.generate({ prompt: "image" }, operation()).catch((value) => value);
    expect(error).toMatchObject({ code: "unavailable", retryable: true });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
  });

  it("preserves unknown outcome and does not retry image generation after a network failure", async () => {
    let calls = 0;
    const driver = createOpenAiImageDriver({
      fetch: async () => {
        calls += 1;
        throw new Error("socket closed after write");
      },
    });
    const client = await driver.create(imageConfig(driver), createContext());

    await expect(client.generate({ prompt: "image" }, operation())).rejects.toMatchObject({
      code: "unknown_outcome",
      uncertain: true,
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it("preserves unknown outcome and does not retry transcription after a network failure", async () => {
    let calls = 0;
    const driver = createOpenAiSttDriver({
      fetch: async () => {
        calls += 1;
        throw new Error("socket closed after write");
      },
    });
    const client = await driver.create(sttConfig(driver), createContext());

    await expect(
      client.transcribe(
        { audio: { bytes: new Uint8Array([1]), contentType: "audio/wav" } },
        operation(),
      ),
    ).rejects.toMatchObject({ code: "unknown_outcome", uncertain: true, retryable: false });
    expect(calls).toBe(1);
  });

  it("preserves unknown outcome and does not retry speech synthesis after a network failure", async () => {
    let calls = 0;
    const driver = createOpenAiTtsDriver({
      fetch: async () => {
        calls += 1;
        throw new Error("socket closed after write");
      },
    });
    const client = await driver.create(ttsConfig(driver), createContext());

    await expect(client.synthesize({ text: "Read this" }, operation())).rejects.toMatchObject({
      code: "unknown_outcome",
      uncertain: true,
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it("stops consuming an oversized JSON image response at the configured limit", async () => {
    const maxResponseBytes = 16 * 1024;
    const probe = streamProbe(new Uint8Array(maxResponseBytes + 1), "application/json", "close");
    const driver = createOpenAiImageDriver({ fetch: async () => probe.response });
    const client = await driver.create(imageConfig(driver, { maxResponseBytes }), createContext());

    await expect(client.generate({ prompt: "image" }, operation())).rejects.toMatchObject({
      code: "failed",
      safeMessage: "The provider response was too large.",
    });
    expect(probe.pulls()).toBe(1);
    expect(probe.cancelled()).toBe(true);
  });

  it("cancels a hanging JSON image body when the operation is aborted", async () => {
    const controller = new AbortController();
    const payload = new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: "AQID" }] }));
    const probe = streamProbe(payload, "application/json", "hang");
    const driver = createOpenAiImageDriver({ fetch: async () => probe.response });
    const client = await driver.create(imageConfig(driver), createContext());
    const pending = client.generate({ prompt: "image" }, operation(controller.signal));
    await Promise.race([probe.started, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
    controller.abort();

    const outcome = await settleWithin(pending);
    if (outcome.kind === "timeout") await settleAfterRelease(pending, probe.release);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.error).toMatchObject({ code: "cancelled" });
    expect(probe.cancelled()).toBe(true);
  });

  it("bounds buffered STT and TTS bodies instead of reading them to completion", async () => {
    const maxResponseBytes = 16 * 1024;
    const sttProbe = streamProbe(new Uint8Array(maxResponseBytes + 1), "application/json", "close");
    const sttDriver = createOpenAiSttDriver({ fetch: async () => sttProbe.response });
    const sttClient = await sttDriver.create(
      sttConfig(sttDriver, { maxResponseBytes }),
      createContext(),
    );
    await expect(
      sttClient.transcribe(
        { audio: { bytes: new Uint8Array([1]), contentType: "audio/wav" } },
        operation(),
      ),
    ).rejects.toMatchObject({
      code: "failed",
      safeMessage: "The provider response was too large.",
    });

    const ttsProbe = streamProbe(new Uint8Array(maxResponseBytes + 1), "audio/mpeg", "close");
    const ttsDriver = createOpenAiTtsDriver({ fetch: async () => ttsProbe.response });
    const ttsClient = await ttsDriver.create(
      ttsConfig(ttsDriver, { maxResponseBytes }),
      createContext(),
    );
    await expect(ttsClient.synthesize({ text: "Read this" }, operation())).rejects.toMatchObject({
      code: "failed",
      safeMessage: "The speech provider response was too large.",
    });

    expect(sttProbe.pulls()).toBe(1);
    expect(sttProbe.cancelled()).toBe(true);
    expect(ttsProbe.pulls()).toBe(1);
    expect(ttsProbe.cancelled()).toBe(true);
  });
});
