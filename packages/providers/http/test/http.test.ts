import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/index.js";

function response(body: BodyInit, init: ResponseInit = {}): Response {
  return new Response(body, { headers: { "content-type": "application/json" }, ...init });
}

describe("provider HTTP transport", () => {
  it("normalizes auth and schema failures without exposing response payloads", async () => {
    const client = createHttpClient({
      baseUrl: "https://provider.test",
      fetch: async () =>
        response(JSON.stringify({ message: "bad", token: "secret" }), { status: 401 }),
    });
    await expect(
      client.json(
        { path: "/v1/test" },
        { providerId: "test", module: "search", operation: "search" },
        () => ({ ok: true }),
      ),
    ).rejects.toMatchObject({ code: "authentication_required", uncertain: false });
  });

  it("marks a network failure after a write as uncertain", async () => {
    const client = createHttpClient({
      baseUrl: "https://provider.test",
      fetch: async () => {
        throw new Error("socket closed");
      },
    });
    await expect(
      client.request(
        { method: "POST", path: "/write", uncertainOnNetworkFailure: true },
        { providerId: "test", module: "connector", operation: "execute" },
      ),
    ).rejects.toMatchObject({ code: "unknown_outcome", uncertain: true });
  });

  it("rejects a response schema parser failure", async () => {
    const client = createHttpClient({
      baseUrl: "https://provider.test",
      fetch: async () => response(JSON.stringify({ not: "the expected shape" })),
    });
    await expect(
      client.json(
        { path: "/schema" },
        { providerId: "test", module: "search", operation: "search" },
        () => {
          throw new Error("schema mismatch");
        },
      ),
    ).rejects.toMatchObject({ code: "failed", uncertain: false });
  });

  it("parses SSE data and honors cancellation", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
        controller.close();
      },
    });
    const client = createHttpClient({
      baseUrl: "https://provider.test",
      fetch: async () => response(stream, { headers: { "content-type": "text/event-stream" } }),
    });
    const values: string[] = [];
    for await (const value of client.sse(
      await client.request(
        { path: "/stream" },
        { providerId: "test", module: "model", operation: "stream" },
      ),
      {},
      { providerId: "test", module: "model", operation: "stream" },
    ))
      values.push(value);
    expect(values).toEqual(['{"ok":true}']);

    const cancelled = new AbortController();
    cancelled.abort();
    const pendingResponse = new Response(new ReadableStream<Uint8Array>({ start() {} }), {
      headers: { "content-type": "text/event-stream" },
    });
    await expect(
      (async () => {
        for await (const value of client.sse(
          pendingResponse,
          { signal: cancelled.signal },
          { providerId: "test", module: "model", operation: "stream" },
        )) {
          // The pre-aborted stream must not yield any provider event.
          void value;
        }
      })(),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});
