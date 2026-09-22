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

  it("bounds oversized error bodies before normalizing their status", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32 * 1024));
      },
      pull() {
        pulls += 1;
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const client = createHttpClient({
      baseUrl: "https://provider.test",
      fetch: async () =>
        new Response(body, { status: 500, headers: { "content-type": "application/json" } }),
    });

    await expect(
      client.request(
        { path: "/error" },
        { providerId: "test", module: "search", operation: "search" },
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
  });

  it("does not await a stalled response cancellation after operation abort", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const client = createHttpClient({
      baseUrl: "https://provider.test",
      fetch: async () => new Response(body),
    });
    const pending = client.json(
      { path: "/stall", signal: controller.signal },
      { providerId: "test", module: "search", operation: "search" },
      (value) => value,
    );
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(cancelled).toBe(true);
  });

  it("keeps the request deadline through a stalled response body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    const client = createHttpClient({
      baseUrl: "https://provider.test",
      defaultTimeoutMs: 20,
      fetch: async () => new Response(body),
    });

    await expect(
      client.json(
        { path: "/deadline" },
        { providerId: "test", module: "search", operation: "search" },
        (value) => value,
      ),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(cancelled).toBe(true);
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
