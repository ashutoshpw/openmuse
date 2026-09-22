import { describe, expect, it } from "vitest";
import {
  createAppConnectConnectorDriver,
  type AppConnectConnectionContext,
  type AppConnectDriverOptions,
} from "../src/index.js";

const context = { signal: new AbortController().signal, operationId: "operation-1" };

const config = {
  endpoint: "https://appconnect.test",
  clientIdSecret: "appconnect-client-id",
  clientSecretSecret: "appconnect-client-secret",
  redirectUri: "https://openmuse.test/api/appconnect/callback",
  sdkVersion: "0.1.0" as const,
  requestTimeoutMs: 10_000,
  maxResponseBytes: 100_000,
};

const connection: AppConnectConnectionContext = {
  connection: {
    connectionId: "connection-1",
    app: "calendar",
    status: "active",
    stateRevision: 1,
    capabilities: ["calendar.read"],
  },
  service: "google-calendar",
  accessToken: "user-access-token",
};

function driverOptions(overrides: Partial<AppConnectDriverOptions> = {}): AppConnectDriverOptions {
  return {
    ...overrides,
    resolveConnection: async () => connection,
  };
}

describe("AppConnect connector adapter", () => {
  it("uses the documented Link, OAuth, tools, and revoke routes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const driver = createAppConnectConnectorDriver({
      ...driverOptions({
        fetch: async (input, init = {}) => {
          const url = String(input);
          calls.push({ url, init });
          const path = new URL(url).pathname;
          if (path === "/api/link-tokens")
            return new Response(
              JSON.stringify({
                link_token: "link-token-1",
                link_url: "https://appconnect.test/link/link-token-1",
                expires_at: "2026-09-22T10:00:00Z",
              }),
              { status: 201, headers: { "content-type": "application/json" } },
            );
          if (path === "/api/link-tokens/exchange")
            return new Response(
              JSON.stringify({
                status: "connected",
                user_id: "user-1",
                state: "state-1",
                access_token: "link-access-token",
                refresh_token: "link-refresh-token",
                token_type: "Bearer",
                expires_at: "2026-09-22T11:00:00Z",
                connected_services: ["google-calendar"],
              }),
              { headers: { "content-type": "application/json" } },
            );
          if (path === "/api/oauth/token")
            return new Response(
              JSON.stringify({
                success: true,
                data: {
                  access_token: "oauth-access-token",
                  refresh_token: "oauth-refresh-token",
                  token_type: "Bearer",
                  expires_in: 3600,
                },
              }),
              { headers: { "content-type": "application/json" } },
            );
          if (path === "/api/tools/search")
            return new Response(
              JSON.stringify({ query: "events", tools: [{ id: "google_calendar_list_events" }] }),
              { headers: { "content-type": "application/json" } },
            );
          if (path === "/api/tools")
            return new Response(
              JSON.stringify({ success: true, data: [{ id: "google_calendar_list_calendars" }] }),
              { headers: { "content-type": "application/json" } },
            );
          if (path === "/api/tools/execute")
            return new Response(JSON.stringify({ success: true, data: { events: [] } }), {
              headers: { "content-type": "application/json" },
            });
          if (path === "/api/connections")
            return new Response(JSON.stringify({ success: true }), {
              headers: { "content-type": "application/json" },
            });
          return new Response(JSON.stringify({ error: "unexpected route" }), { status: 404 });
        },
      }),
    });
    const client = await driver.create(config, {
      signal: context.signal,
      scopeId: "scope",
      secrets: {
        resolve: async (reference) =>
          reference === "appconnect-client-id" ? "client-id" : "client-secret",
      },
    });

    await expect(
      client.beginLink(
        { userId: "user-1", state: "state-1", allowedServices: ["google-calendar"] },
        context,
      ),
    ).resolves.toMatchObject({ linkToken: "link-token-1" });
    await expect(
      client.exchangeLinkToken({ linkToken: "link-token-1" }, context),
    ).resolves.toMatchObject({
      accessToken: "link-access-token",
      refreshToken: "link-refresh-token",
    });
    await expect(
      client.exchangeAuthorizationCode({ code: "code-1" }, context),
    ).resolves.toMatchObject({
      accessToken: "oauth-access-token",
      expiresIn: 3600,
    });
    await expect(
      client.refreshToken({ refreshToken: "refresh-1" }, context),
    ).resolves.toMatchObject({
      accessToken: "oauth-access-token",
    });
    await expect(client.listTools("connection-1", context)).resolves.toEqual([
      { id: "google_calendar_list_calendars", tool_id: "google_calendar_list_calendars" },
    ]);
    await expect(client.searchTools("connection-1", "events", context)).resolves.toEqual([
      { id: "google_calendar_list_events", tool_id: "google_calendar_list_events" },
    ]);
    await expect(
      client.execute(
        {
          connectionId: "connection-1",
          operation: "execute_tool",
          input: { tool_id: "google_calendar_list_events", arguments: { maxResults: 10 } },
        },
        context,
      ),
    ).resolves.toEqual({ data: { events: [] } });
    await expect(client.revoke("connection-1", context)).resolves.toBeUndefined();

    expect(
      calls.map((call) => `${call.init.method ?? "GET"} ${new URL(call.url).pathname}`),
    ).toEqual([
      "POST /api/link-tokens",
      "POST /api/link-tokens/exchange",
      "POST /api/oauth/token",
      "POST /api/oauth/token",
      "GET /api/tools",
      "GET /api/tools/search",
      "POST /api/tools/execute",
      "DELETE /api/connections",
    ]);
    const linkBody = JSON.parse(String(calls[0]?.init.body));
    expect(linkBody).toMatchObject({
      client_id: "client-id",
      client_secret: "client-secret",
      user_id: "user-1",
    });
    expect(linkBody).not.toHaveProperty("access_token");
    expect(new Headers(calls[4]?.init.headers).get("Authorization")).toBe(
      "Bearer user-access-token",
    );
    const executeBody = JSON.parse(String(calls[6]?.init.body));
    expect(executeBody).toEqual({
      tool_id: "google_calendar_list_events",
      params: { maxResults: 10 },
    });
    expect(calls[7]?.url).toContain("/api/connections?service=google-calendar");
  });

  it("keeps connection state and tokens in the host application", async () => {
    const driver = createAppConnectConnectorDriver(
      driverOptions({
        platform: {
          async createLinkToken() {
            return {
              linkToken: "link-token-1",
              authorizationUrl: "https://appconnect.test/link",
              expiresAt: "2026-09-22T10:00:00Z",
            };
          },
          async exchangeLinkToken() {
            return { status: "pending", message: "Waiting for user" };
          },
          async exchangeAuthorizationCode() {
            return { status: "connected", accessToken: "access-token" };
          },
          async refreshToken() {
            return { status: "connected", accessToken: "access-token" };
          },
          async listTools() {
            return [{ id: "google_calendar_list_events", tool_id: "google_calendar_list_events" }];
          },
          async searchTools() {
            return [];
          },
          async executeTool() {
            return { data: { ok: true } };
          },
          async revokeConnection() {},
        },
      }),
    );
    const client = await driver.create(config, { signal: context.signal, scopeId: "scope" });
    await expect(client.getConnection("connection-1", context)).resolves.toEqual(
      connection.connection,
    );
    await expect(
      client.exchangeLinkCode({ linkToken: "link-token-1" }, context),
    ).resolves.toMatchObject({ status: "pending" });
    await expect(client.listTools("connection-1", context)).resolves.toHaveLength(1);
  });

  it("marks a network failure during tool execution as an unknown outcome", async () => {
    const driver = createAppConnectConnectorDriver(
      driverOptions({
        fetch: async () => {
          throw new Error("socket closed after dispatch");
        },
      }),
    );
    const client = await driver.create(config, {
      signal: context.signal,
      scopeId: "scope",
      secrets: { resolve: async () => "secret" },
    });
    await expect(
      client.execute(
        {
          connectionId: "connection-1",
          operation: "execute_tool",
          input: { tool_id: "google_calendar_create_event", arguments: {} },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "unknown_outcome", uncertain: true });
  });
});
