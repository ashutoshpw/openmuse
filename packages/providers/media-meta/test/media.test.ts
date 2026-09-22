import { describe, expect, it } from "vitest";
import { createMetaImageDriver, createMetaSttDriver } from "../src/index.js";

const secret = "meta-test-secret";
const createContext = {
  signal: new AbortController().signal,
  scopeId: "workspace-1",
  secrets: { resolve: async () => secret },
};

function operation(id = "operation-1") {
  return { signal: new AbortController().signal, operationId: id };
}

interface WavOptions {
  dataBytes?: number;
  channels?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  audioFormat?: number;
  contentType?: string;
}

function wav(options: WavOptions = {}): Uint8Array {
  const dataBytes = options.dataBytes ?? 32_000;
  const channels = options.channels ?? 1;
  const sampleRate = options.sampleRate ?? 16_000;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const audioFormat = options.audioFormat ?? 1;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, 36 + dataBytes, true);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  bytes.set(new TextEncoder().encode("fmt "), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, dataBytes, true);
  return bytes;
}

function imageConfig(driver: ReturnType<typeof createMetaImageDriver>) {
  return driver.config.schema.parse({
    endpoint: "https://api.meta.test/v1",
    apiKeySecret: "meta-key",
  });
}

function sttConfig(
  driver: ReturnType<typeof createMetaSttDriver>,
  overrides: Record<string, unknown> = {},
) {
  return driver.config.schema.parse({
    endpoint: "https://api.meta.test/v1",
    apiKeySecret: "meta-key",
    ...overrides,
  });
}

describe("Meta image adapter", () => {
  it("sends the documented single-image base64 request and normalizes bytes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const driver = createMetaImageDriver({
      fetch: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return new Response(
          JSON.stringify({ id: "image-operation-1", data: [{ b64_json: "AQID" }] }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const client = await driver.create(imageConfig(driver), createContext);

    const result = await client.generate(
      { prompt: "A small blue bird", width: 1024, height: 768 },
      operation(),
    );

    expect([...result.image.bytes]).toEqual([1, 2, 3]);
    expect(result.image).toMatchObject({ contentType: "image/webp", fileName: "meta-image.webp" });
    expect(result.providerOperationId).toBe("image-operation-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.meta.test/v1/images/generations");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${secret}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "muse-image-1.0",
      prompt: "A small blue bird",
      n: 1,
      response_format: "b64_json",
      output_format: "webp",
      size: "1024x768",
    });
  });

  it("fails closed on URL-only image responses without fetching the URL", async () => {
    let calls = 0;
    const driver = createMetaImageDriver({
      fetch: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ data: [{ url: "https://provider.test/image.png" }] }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      },
    });
    const client = await driver.create(imageConfig(driver), createContext);

    await expect(client.generate({ prompt: "image" }, operation())).rejects.toMatchObject({
      code: "failed",
    });
    expect(calls).toBe(1);
  });

  it("redacts resolved credentials from normalized provider errors", async () => {
    const driver = createMetaImageDriver({
      fetch: async () =>
        new Response(JSON.stringify({ message: `upstream leaked ${secret}` }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    });
    const client = await driver.create(imageConfig(driver), createContext);

    const error = await client.generate({ prompt: "image" }, operation()).catch((value) => value);
    expect(error).toMatchObject({ code: "unavailable", retryable: true });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
  });
});

describe("Meta transcription adapter", () => {
  it("sends the exact JSON and WAV multipart parts and maps the transcript", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const driver = createMetaSttDriver({
      fetch: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            sessionId: "transcription-1",
            transcript: "hello world",
            language: "en",
            turns: [
              { transcript: "hello", startMs: 0, endMs: 400, speaker: "A" },
              { transcript: "world", startMs: 500, endMs: 1000, speaker: "B" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const client = await driver.create(sttConfig(driver), createContext);
    const audio = wav();

    const result = await client.transcribe(
      {
        audio: { bytes: audio, contentType: "audio/wav", fileName: "voice.wav" },
        language: "en",
        diarize: true,
      },
      operation("transcription-1"),
    );

    expect(result).toEqual({
      text: "hello world",
      language: "en",
      words: [
        { text: "hello", startMs: 0, endMs: 400, speaker: "A" },
        { text: "world", startMs: 500, endMs: 1000, speaker: "B" },
      ],
      providerOperationId: "transcription-1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.meta.test/v1/asr/transcribe");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${secret}`);
    expect(new Headers(calls[0]?.init.headers).get("accept")).toBe("application/json");

    const body = calls[0]?.init.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    const requestPart = form.get("request");
    expect(requestPart).toBeInstanceOf(Blob);
    expect(JSON.parse(await (requestPart as Blob).text())).toEqual({
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "DIARIZATION",
      languageBias: ["en"],
    });
    const audioPart = form.get("audio");
    expect(audioPart).toBeInstanceOf(File);
    expect((audioPart as File).name).toBe("voice.wav");
    expect((audioPart as File).type).toBe("audio/wav");
    expect((audioPart as File).size).toBe(audio.byteLength);
    expect([...new Uint8Array(await (audioPart as Blob).arrayBuffer())]).toEqual([...audio]);
  });

  it("rejects malformed and unsupported WAV inputs before making a request", async () => {
    let calls = 0;
    const driver = createMetaSttDriver({
      fetch: async () => {
        calls += 1;
        return new Response("{}", { headers: { "content-type": "application/json" } });
      },
    });
    const client = await driver.create(sttConfig(driver), createContext);
    const cases: Array<{ name: string; audio: Uint8Array; contentType?: string }> = [
      { name: "not RIFF", audio: new Uint8Array(44) },
      { name: "stereo", audio: wav({ channels: 2 }) },
      { name: "float PCM", audio: wav({ audioFormat: 3 }) },
      { name: "unsupported sample rate", audio: wav({ sampleRate: 8_000 }) },
      { name: "wrong MIME", audio: wav(), contentType: "audio/mpeg" },
    ];

    for (const testCase of cases) {
      await expect(
        client.transcribe(
          {
            audio: {
              bytes: testCase.audio,
              contentType: testCase.contentType ?? "audio/wav",
            },
          },
          operation(testCase.name),
        ),
      ).rejects.toMatchObject({ code: "failed" });
    }
    expect(calls).toBe(0);
  });

  it("accepts exactly ten minutes and rejects audio beyond the provider bound", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const driver = createMetaSttDriver({
      fetch: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ transcript: "ok" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const client = await driver.create(sttConfig(driver), createContext);
    const tenMinutes = wav({ dataBytes: 16_000 * 2 * 60 * 10 });
    await expect(
      client.transcribe(
        { audio: { bytes: tenMinutes, contentType: "audio/wav" } },
        operation("ten-minutes"),
      ),
    ).resolves.toMatchObject({ text: "ok" });

    const tooLong = wav({ dataBytes: tenMinutes.byteLength - 44 + 32 });
    await expect(
      client.transcribe(
        { audio: { bytes: tooLong, contentType: "audio/wav" } },
        operation("too-long"),
      ),
    ).rejects.toMatchObject({ code: "failed", safeMessage: "The audio is too long." });
    expect(calls).toHaveLength(1);
  });

  it("honors input and request size bounds without sending audio", async () => {
    let calls = 0;
    const driver = createMetaSttDriver({
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ transcript: "unexpected" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const client = await driver.create(
      sttConfig(driver, { maxInputBytes: 100, maxRequestBytes: 100 }),
      createContext,
    );

    await expect(
      client.transcribe(
        { audio: { bytes: wav(), contentType: "audio/wav" } },
        operation("size-bound"),
      ),
    ).rejects.toMatchObject({ code: "failed" });
    expect(calls).toBe(0);
  });

  it("propagates cancellation through the shared HTTP boundary", async () => {
    const controller = new AbortController();
    const driver = createMetaImageDriver({
      fetch: async (_input, init = {}) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          if (signal.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    const client = await driver.create(imageConfig(driver), createContext);
    const pending = client.generate(
      { prompt: "image" },
      { signal: controller.signal, operationId: "cancelled" },
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "cancelled",
      safeMessage: "The provider request was cancelled.",
    });
  });
});
