import { describe, expect, it } from "vitest";
import type {
  ImageDriver,
  ProviderCreateContext,
  ProviderOperationContext,
  SttDriver,
} from "@openmuse/provider-contracts";
import { createMetaImageDriver, createMetaSttDriver } from "../src/index.js";

const secret = "meta-review-secret";

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
    endpoint: "https://api.meta.test/v1",
    apiKeySecret: "meta-key",
    ...overrides,
  });
}

function sttConfig(driver: SttDriver, overrides: Record<string, unknown> = {}) {
  return driver.config.schema.parse({
    endpoint: "https://api.meta.test/v1",
    apiKeySecret: "meta-key",
    ...overrides,
  });
}

function wav(): Uint8Array {
  const dataBytes = 32_000;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + dataBytes, true);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  bytes.set(new TextEncoder().encode("fmt "), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, dataBytes, true);
  return bytes;
}

type StreamProbe = {
  response: Response;
  pulls: () => number;
  cancelled: () => boolean;
  release: () => void;
  started: Promise<void>;
};

function streamProbe(body: Uint8Array, contentType: string): StreamProbe {
  let pullCount = 0;
  let didCancel = false;
  let releasePull: (() => void) | undefined;
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      // Bun may pull once while constructing Response; keep that prefetch out of the read count.
      value.enqueue(body);
    },
    pull(value) {
      pullCount += 1;
      resolveStarted?.();
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

describe("Meta independent media regressions", () => {
  it("rejects noncanonical base64 instead of accepting atob's permissive decoding", async () => {
    const driver = createMetaImageDriver({
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

  it("preserves unknown outcome and does not retry image generation after a network failure", async () => {
    let calls = 0;
    const driver = createMetaImageDriver({
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
    const driver = createMetaSttDriver({
      fetch: async () => {
        calls += 1;
        throw new Error("socket closed after write");
      },
    });
    const client = await driver.create(sttConfig(driver), createContext());

    await expect(
      client.transcribe({ audio: { bytes: wav(), contentType: "audio/wav" } }, operation()),
    ).rejects.toMatchObject({ code: "unknown_outcome", uncertain: true, retryable: false });
    expect(calls).toBe(1);
  });

  it("stops consuming oversized image and transcription responses at the configured limit", async () => {
    const maxResponseBytes = 16 * 1024;
    const imageProbe = streamProbe(new Uint8Array(maxResponseBytes + 1), "application/json");
    const imageDriver = createMetaImageDriver({ fetch: async () => imageProbe.response });
    const imageClient = await imageDriver.create(
      imageConfig(imageDriver, { maxResponseBytes }),
      createContext(),
    );
    await expect(imageClient.generate({ prompt: "image" }, operation())).rejects.toMatchObject({
      code: "failed",
      safeMessage: "The provider response was too large.",
    });

    const sttProbe = streamProbe(new Uint8Array(maxResponseBytes + 1), "application/json");
    const sttDriver = createMetaSttDriver({ fetch: async () => sttProbe.response });
    const sttClient = await sttDriver.create(
      sttConfig(sttDriver, { maxResponseBytes }),
      createContext(),
    );
    await expect(
      sttClient.transcribe({ audio: { bytes: wav(), contentType: "audio/wav" } }, operation()),
    ).rejects.toMatchObject({
      code: "failed",
      safeMessage: "The provider response was too large.",
    });

    expect(imageProbe.pulls()).toBe(1);
    expect(imageProbe.cancelled()).toBe(true);
    expect(sttProbe.pulls()).toBe(1);
    expect(sttProbe.cancelled()).toBe(true);
  });

  it("cancels a hanging JSON image body when the operation is aborted", async () => {
    const controller = new AbortController();
    const payload = new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: "AQID" }] }));
    const probe = streamProbe(payload, "application/json");
    const driver = createMetaImageDriver({ fetch: async () => probe.response });
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

  it("redacts the resolved API key from a transcription provider error", async () => {
    const driver = createMetaSttDriver({
      fetch: async () =>
        new Response(JSON.stringify({ message: `upstream leaked ${secret}` }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    });
    const client = await driver.create(sttConfig(driver), createContext());

    const error = await client
      .transcribe({ audio: { bytes: wav(), contentType: "audio/wav" } }, operation())
      .catch((value) => value);
    expect(error).toMatchObject({ code: "unavailable", retryable: true });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
  });

  it("redacts the resolved API key from a normalized transport cause", async () => {
    const driver = createMetaImageDriver({
      fetch: async () => {
        throw new Error(`transport leaked ${secret}`);
      },
    });
    const client = await driver.create(imageConfig(driver), createContext());

    const error = await client.generate({ prompt: "image" }, operation()).catch((value) => value);
    expect(error).toMatchObject({ code: "unknown_outcome" });
    expect((error as Error).message).not.toContain(secret);
    expect((error as { details?: { cause?: string } }).details?.cause).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("redacts the resolved API key from an upstream provider code", async () => {
    const driver = createMetaImageDriver({
      fetch: async () =>
        new Response(JSON.stringify({ code: secret, message: "upstream failure" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    });
    const client = await driver.create(imageConfig(driver), createContext());

    const error = await client.generate({ prompt: "image" }, operation()).catch((value) => value);
    expect(error).toMatchObject({ code: "unavailable" });
    expect((error as { providerCode?: string }).providerCode).not.toContain(secret);
    expect((error as { details?: { providerCode?: string } }).details?.providerCode).not.toContain(
      secret,
    );
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
