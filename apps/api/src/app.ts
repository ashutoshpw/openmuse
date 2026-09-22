import { randomUUID } from "node:crypto";
import { cors } from "hono/cors";
import { Hono } from "hono";
import type { OpenMuseAuth, RequestIdentity } from "@openmuse/auth";
import { ApplicationError, OpenMuseApplication } from "@openmuse/application";
import { createSessionInputSchema } from "@openmuse/contracts";
import type { DatabaseClient } from "@openmuse/db";
import { ScopedDatabase } from "@openmuse/db";
import { envelope, jsonError, parseJson, type ApiEnv } from "./http.js";
import { registerCoreRoutes } from "./routes/core.js";

export interface ApiOptions {
  db: DatabaseClient;
  auth: OpenMuseAuth;
  allowedOrigins: readonly string[];
  requestTimeoutMs?: number;
}

async function resolveConversationWorkspace(
  db: DatabaseClient,
  conversationId: string,
  actorId: string,
): Promise<string | undefined> {
  const [row] = await db.sql<{ workspace_id: string }[]>`
    select openmuse_resolve_conversation_workspace(${conversationId}, ${actorId}) as workspace_id
  `;
  return row?.workspace_id;
}

function currentSession(identity: RequestIdentity) {
  const now = new Date();
  const createdAt = identity.createdAt ?? now;
  const lastSeenAt = identity.lastSeenAt ?? now;
  return {
    id: identity.sessionId,
    createdAt: createdAt.toISOString(),
    updatedAt: lastSeenAt.toISOString(),
    userId: identity.userId,
    expiresAt: identity.expiresAt.toISOString(),
    lastSeenAt: lastSeenAt.toISOString(),
    revokedAt: null,
    scopes: ["api"],
  };
}

export function createApi(options: ApiOptions) {
  const app = new Hono<ApiEnv>();
  const originSet = new Set(options.allowedOrigins);
  app.use(
    "/api/*",
    cors({
      origin: (origin) =>
        origin && originSet.has(origin) ? origin : (options.allowedOrigins[0] ?? ""),
      credentials: true,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "X-OpenMuse-Workspace"],
    }),
  );

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.all("/api/auth/*", (c) => options.auth.handler(c.req.raw));

  app.use("/api/v1/*", async (c, next) => {
    const requestId = c.req.header("x-request-id")?.trim() || randomUUID();
    c.header("x-request-id", requestId);
    const origin = c.req.header("origin");
    const referer = c.req.header("referer");
    const authorization = c.req.header("authorization")?.trim() ?? "";
    const hasBearer = /^Bearer\s+\S+$/i.test(authorization);
    // Cookie-authenticated mutations must be same-origin. Bearer clients may
    // be native and legitimately omit Origin; Better Auth still validates the
    // session itself.
    let browserOriginAllowed = origin ? originSet.has(origin) : false;
    if (!origin && referer) {
      try {
        browserOriginAllowed = originSet.has(new URL(referer).origin);
      } catch {
        browserOriginAllowed = false;
      }
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && !hasBearer && !browserOriginAllowed) {
      return c.json(
        {
          error: {
            code: "forbidden",
            message: "A same-origin browser request or explicit bearer token is required.",
            requestId,
          },
        },
        403,
      );
    }
    try {
      const identity = await options.auth.getIdentity(c.req.raw);
      c.set("identity", identity);
      c.set("requestId", requestId);
      await next();
    } catch (error) {
      return jsonError(c, error, requestId);
    }
  });

  registerCoreRoutes(app, options);

  app.get("/api/v1/sessions/current", (c) => {
    const identity = c.get("identity");
    return envelope(c, currentSession(identity), c.get("requestId"));
  });

  app.post("/api/v1/sessions", async (c) => {
    try {
      const parsed = createSessionInputSchema.safeParse(await parseJson(c));
      if (!parsed.success)
        throw new ApplicationError("Invalid session input", "invalid_request", 400);
      // Better Auth is the session issuer. This compatibility endpoint returns
      // the already-authenticated durable session rather than minting a second
      // token outside Better Auth's rotation and revocation rules.
      return envelope(c, currentSession(c.get("identity")), c.get("requestId"));
    } catch (error) {
      return jsonError(c, error, c.get("requestId"));
    }
  });

  app.delete("/api/v1/sessions/:sessionId", async (c) => {
    try {
      await options.auth.revokeSession(c.req.raw, c.req.param("sessionId"));
      return c.body(null, 204);
    } catch (error) {
      return jsonError(c, error, c.get("requestId"));
    }
  });

  app.post("/api/v1/workspaces", async (c) => {
    const identity = c.get("identity");
    const workspaceId = randomUUID();
    const scoped = new ScopedDatabase(options.db.db, { workspaceId, actorId: identity.userId });
    const service = new OpenMuseApplication(scoped);
    try {
      return envelope(c, await service.createWorkspace(await parseJson(c)), c.get("requestId"));
    } catch (error) {
      return jsonError(c, error, c.get("requestId"));
    }
  });

  app.post("/api/v1/workspaces/:workspaceId/conversations", async (c) => {
    const identity = c.get("identity");
    const workspaceId = c.req.param("workspaceId");
    const service = new OpenMuseApplication(
      new ScopedDatabase(options.db.db, { workspaceId, actorId: identity.userId }),
    );
    try {
      const body = await parseJson(c);
      return envelope(
        c,
        await service.createConversation({
          ...(typeof body === "object" && body ? body : {}),
          workspaceId,
        }),
        c.get("requestId"),
      );
    } catch (error) {
      return jsonError(c, error, c.get("requestId"));
    }
  });

  app.get("/api/v1/workspaces/:workspaceId/conversations", async (c) => {
    const identity = c.get("identity");
    const workspaceId = c.req.param("workspaceId");
    const service = new OpenMuseApplication(
      new ScopedDatabase(options.db.db, { workspaceId, actorId: identity.userId }),
    );
    try {
      const items = await service.listConversations();
      return envelope(c, { items, page: { nextCursor: null, hasMore: false } }, c.get("requestId"));
    } catch (error) {
      return jsonError(c, error, c.get("requestId"));
    }
  });

  app.get("/api/v1/conversations/:conversationId", async (c) => {
    const identity = c.get("identity");
    try {
      const workspaceId = await resolveConversationWorkspace(
        options.db,
        c.req.param("conversationId"),
        identity.userId,
      );
      if (!workspaceId) throw new ApplicationError("Conversation not found", "not_found", 404);
      const service = new OpenMuseApplication(
        new ScopedDatabase(options.db.db, { workspaceId, actorId: identity.userId }),
      );
      return envelope(
        c,
        await service.getConversation(c.req.param("conversationId")),
        c.get("requestId"),
      );
    } catch (error) {
      return jsonError(c, error, c.get("requestId"));
    }
  });

  app.post("/api/v1/conversations/:conversationId/messages", async (c) => {
    const identity = c.get("identity");
    try {
      const conversationId = c.req.param("conversationId");
      const workspaceId = await resolveConversationWorkspace(
        options.db,
        conversationId,
        identity.userId,
      );
      if (!workspaceId) throw new ApplicationError("Conversation not found", "not_found", 404);
      const service = new OpenMuseApplication(
        new ScopedDatabase(options.db.db, { workspaceId, actorId: identity.userId }),
      );
      const body = await parseJson(c);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        (body as { conversationId?: unknown }).conversationId !== conversationId
      ) {
        throw new ApplicationError(
          "The message conversationId must match the route.",
          "invalid_request",
          400,
        );
      }
      return envelope(c, await service.sendMessage(body), c.get("requestId"));
    } catch (error) {
      return jsonError(c, error, c.get("requestId"));
    }
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: "not_found",
          message: "Route not found.",
          requestId: c.get("requestId") ?? randomUUID(),
        },
      },
      404,
    ),
  );
  return app;
}

export type ApiApp = ReturnType<typeof createApi>;
