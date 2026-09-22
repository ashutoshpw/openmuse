import { describe, expect, it } from "vitest";
import {
  createOpenAiImageDriver,
  createOpenAiSttDriver,
  createOpenAiTtsDriver,
} from "../src/index.js";

const createContext = {
  signal: new AbortController().signal,
  scopeId: "workspace-1",
  secrets: { resolve: async (reference: string) => `secret-for-${reference}` },
};

function operation(id = "operation-1") {
  return { signal: new AbortController().signal, operationId: id };
}

describe("OpenAI image adapter", () => {
  it("sends the documented single-image base64 request and normalizes bytes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const driver = createOpenAiImageDriver({
      fetch: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return new Response(
          JSON.stringify({ id: "image-operation-1", data: [{ b64_json: "AQID" }] }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const client = await driver.create(
      driver.config.schema.parse({
        endpoint: "https://api.openai.test/v1",
        apiKeySecret: "openai-key",
      }),
      createContext,
    );

    const result = await client.generate({ prompt: "A small blue bird" }, operation());
    expect([...result.image.bytes]).toEqual([1, 2, 3]);
    expect(result.image).toMatchObject({ contentType: "image/png", fileName: "openai-image.png" });
    expect(result.providerOperationId).toBe("image-operation-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.test/v1/images/generations");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer secret-for-openai-key",
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "gpt-image-1",
      prompt: "A small blue bird",
      n: 1,
      output_format: "png",
    });
  });

  it("fails closed on URL-only image responses without fetching the URL", async () => {
    let calls = 0;
    const driver = createOpenAiImageDriver({
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
    const client = await driver.create(
      driver.config.schema.parse({
        endpoint: "https://api.openai.test/v1",
        apiKeySecret: "openai-key",
      }),
      createContext,
    );
    await expect(client.generate({ prompt: "image" }, operation())).rejects.toMatchObject({
      code: "failed",
    });
    expect(calls).toBe(1);
  });
});

describe("OpenAI transcription adapter", () => {
  it("sends multipart fields and parses verbose word timestamps", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const driver = createOpenAiSttDriver({
      fetch: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            id: "transcription-1",
            text: "hello world",
            language: "en",
            words: [
              { word: "hello", start: 0, end: 0.4 },
              { word: "world", start: 0.5, end: 1.0 },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const client = await driver.create(
      driver.config.schema.parse({
        endpoint: "https://api.openai.test/v1",
        apiKeySecret: "openai-key",
      }),
      createContext,
    );
    const result = await client.transcribe(
      {
        audio: {
          bytes: new Uint8Array([0, 1, 2, 3]),
          contentType: "audio/wav",
          fileName: "voice.wav",
        },
        language: "en",
      },
      operation("transcription-1"),
    );

    expect(result).toMatchObject({
      text: "hello world",
      language: "en",
      providerOperationId: "transcription-1",
    });
    expect(result.words).toEqual([
      { text: "hello", startMs: 0, endMs: 400 },
      { text: "world", startMs: 500, endMs: 1000 },
    ]);
    const body = calls[0]?.init.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("language")).toBe("en");
    expect(form.get("timestamp_granularities[]")).toBe("word");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("voice.wav");
    expect((file as File).type).toBe("audio/wav");
    expect((file as File).size).toBe(4);
    expect(calls[0]?.url).toBe("https://api.openai.test/v1/audio/transcriptions");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer secret-for-openai-key",
    );
  });

  it("parses streamed transcript deltas and diarized segments", async () => {
    const driver = createOpenAiSttDriver({
      fetch: async (_input, init = {}) => {
        const form = init.body as FormData;
        expect(form.get("model")).toBe("gpt-4o-transcribe-diarize");
        expect(form.get("response_format")).toBe("diarized_json");
        return new Response(
          [
            'data: {"type":"transcript.text.delta","delta":"hello "}\n\n',
            'data: {"type":"transcript.text.done","text":"hello there","segments":[{"speaker":"A","text":"hello there","start":0,"end":1}]}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const client = await driver.create(
      driver.config.schema.parse({
        endpoint: "https://api.openai.test/v1",
        apiKeySecret: "openai-key",
      }),
      createContext,
    );
    await expect(
      client.transcribe(
        { audio: { bytes: new Uint8Array([1]), contentType: "audio/wav" }, diarize: true },
        operation("stream-1"),
      ),
    ).resolves.toMatchObject({
      text: "hello there",
      words: [{ speaker: "A", startMs: 0, endMs: 1000 }],
    });
  });

  it("does not silently send an unresolved provider reference", async () => {
    const driver = createOpenAiSttDriver({ fetch: async () => new Response() });
    const client = await driver.create(
      driver.config.schema.parse({
        endpoint: "https://api.openai.test/v1",
        apiKeySecret: "openai-key",
      }),
      createContext,
    );
    await expect(
      client.transcribe({ audio: { id: "artifact-1", contentType: "audio/wav" } }, operation()),
    ).rejects.toMatchObject({ code: "failed" });
  });
});

describe("OpenAI speech adapter", () => {
  it("sends the documented JSON request and preserves the declared binary format", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const driver = createOpenAiTtsDriver({
      fetch: async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/wav" },
        });
      },
    });
    const client = await driver.create(
      driver.config.schema.parse({
        endpoint: "https://api.openai.test/v1",
        apiKeySecret: "openai-key",
      }),
      createContext,
    );
    const result = await client.synthesize(
      { text: "Read this", voice: "verse", format: "wav" },
      operation("speech-1"),
    );
    expect([...result.audio.bytes]).toEqual([1, 2, 3]);
    expect(result.audio).toMatchObject({ contentType: "audio/wav", fileName: "openai-speech.wav" });
    expect(calls[0]?.url).toBe("https://api.openai.test/v1/audio/speech");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "gpt-4o-mini-tts",
      input: "Read this",
      voice: "verse",
      response_format: "wav",
    });
  });

  it("rejects a response whose MIME does not match the requested audio format", async () => {
    const driver = createOpenAiTtsDriver({
      fetch: async () =>
        new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }),
    });
    const client = await driver.create(
      driver.config.schema.parse({
        endpoint: "https://api.openai.test/v1",
        apiKeySecret: "openai-key",
      }),
      createContext,
    );
    await expect(
      client.synthesize({ text: "Read this", format: "wav" }, operation()),
    ).rejects.toMatchObject({
      code: "failed",
    });
  });
});
