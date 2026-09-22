import type { Hono } from "hono";
import { ApplicationError, OpenMuseApplication, toWorkspace } from "@openmuse/application";
import { listInputSchema } from "@openmuse/contracts";
import type { DatabaseClient } from "@openmuse/db";
import {
  ScopedDatabase,
  WorkspaceDirectoryRepository,
  resolveResourceWorkspace,
} from "@openmuse/db";
import { envelope, jsonError, parseJson, type ApiContext, type ApiEnv } from "../http.js";

interface CoreRouteOptions {
  db: DatabaseClient;
}

function service(c: ApiContext, db: DatabaseClient, workspaceId: string): OpenMuseApplication {
  return new OpenMuseApplication(
    new ScopedDatabase(db.db, { workspaceId, actorId: c.get("identity").userId }),
  );
}

function pageQuery(c: ApiContext) {
  const parsed = listInputSchema.safeParse({
    ...(c.req.query("limit") === undefined ? {} : { limit: Number(c.req.query("limit")) }),
    ...(c.req.query("cursor") === undefined ? {} : { cursor: c.req.query("cursor") }),
  });
  if (!parsed.success)
    throw new ApplicationError("Invalid pagination query", "invalid_request", 400);
  return parsed.data;
}

function request(c: ApiContext): string {
  return c.get("requestId");
}

export function registerCoreRoutes(app: Hono<ApiEnv>, options: CoreRouteOptions): void {
  app.get("/api/v1/workspaces", async (c) => {
    try {
      const rows = await new WorkspaceDirectoryRepository(options.db.db).list(
        c.get("identity").userId,
      );
      return envelope(
        c,
        {
          items: rows.map((row) =>
            toWorkspace(
              {
                id: row.id,
                name: row.name,
                slug: row.slug,
                createdBy: row.created_by,
                // Raw SQL function results are returned as ISO strings by
                // postgres-js, while the application mappers expect Date
                // instances from Drizzle table queries.
                createdAt: new Date(row.created_at),
                updatedAt: new Date(row.updated_at),
                archivedAt: null,
              } as never,
              row.role as never,
            ),
          ),
          page: { nextCursor: null, hasMore: false },
        },
        request(c),
      );
    } catch (error) {
      return jsonError(c, error, request(c));
    }
  });

  app.patch("/api/v1/workspaces/:workspaceId", async (c) => {
    try {
      return envelope(
        c,
        await service(c, options.db, c.req.param("workspaceId")).updateWorkspace(
          await parseJson(c),
        ),
        request(c),
      );
    } catch (error) {
      return jsonError(c, error, request(c));
    }
  });

  app.post("/api/v1/conversations", async (c) => {
    try {
      const body = await parseJson(c);
      const workspaceId =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as { workspaceId?: unknown }).workspaceId
          : undefined;
      if (typeof workspaceId !== "string")
        throw new ApplicationError("workspaceId is required", "invalid_request", 400);
      return envelope(
        c,
        await service(c, options.db, workspaceId).createConversation(body),
        request(c),
      );
    } catch (error) {
      return jsonError(c, error, request(c));
    }
  });

  app.patch("/api/v1/conversations/:conversationId", async (c) => {
    try {
      const conversationId = c.req.param("conversationId");
      const workspaceId = await resolveResourceWorkspace(
        options.db.db,
        "conversation",
        conversationId,
        c.get("identity").userId,
      );
      if (!workspaceId) throw new ApplicationError("Conversation not found", "not_found", 404);
      return envelope(
        c,
        await service(c, options.db, workspaceId).updateConversation(
          conversationId,
          await parseJson(c),
        ),
        request(c),
      );
    } catch (error) {
      return jsonError(c, error, request(c));
    }
  });

  app.get("/api/v1/conversations/:conversationId/messages", async (c) => {
    try {
      const conversationId = c.req.param("conversationId");
      const workspaceId = await resolveResourceWorkspace(
        options.db.db,
        "conversation",
        conversationId,
        c.get("identity").userId,
      );
      if (!workspaceId) throw new ApplicationError("Conversation not found", "not_found", 404);
      const query = pageQuery(c);
      const items = await service(c, options.db, workspaceId).listMessages(conversationId);
      const start = query.cursor ? Math.max(Number(query.cursor) - 1, 0) : 0;
      const selected = items.slice(start, start + query.limit + 1);
      return envelope(
        c,
        {
          items: selected.slice(0, query.limit),
          page: {
            nextCursor: selected.length > query.limit ? String(start + query.limit + 1) : null,
            hasMore: selected.length > query.limit,
          },
        },
        request(c),
      );
    } catch (error) {
      return jsonError(c, error, request(c));
    }
  });

  app.get("/api/v1/runs/:runId", async (c) => {
    try {
      const runId = c.req.param("runId");
      const workspaceId = await resolveResourceWorkspace(
        options.db.db,
        "run",
        runId,
        c.get("identity").userId,
      );
      if (!workspaceId) throw new ApplicationError("Run not found", "not_found", 404);
      return envelope(c, await service(c, options.db, workspaceId).getRun(runId), request(c));
    } catch (error) {
      return jsonError(c, error, request(c));
    }
  });

  app.post("/api/v1/runs/:runId/cancel", async (c) => {
    try {
      const runId = c.req.param("runId");
      const workspaceId = await resolveResourceWorkspace(
        options.db.db,
        "run",
        runId,
        c.get("identity").userId,
      );
      if (!workspaceId) throw new ApplicationError("Run not found", "not_found", 404);
      return envelope(
        c,
        await service(c, options.db, workspaceId).cancelRun(runId, await parseJson(c)),
        request(c),
      );
    } catch (error) {
      return jsonError(c, error, request(c));
    }
  });

  app.get("/api/v1/runs/:runId/events", async (c) => {
    try {
      const runId = c.req.param("runId");
      const workspaceId = await resolveResourceWorkspace(
        options.db.db,
        "run",
        runId,
        c.get("identity").userId,
      );
      if (!workspaceId) throw new ApplicationError("Run not found", "not_found", 404);
      const query = pageQuery(c);
      return envelope(
        c,
        await service(c, options.db, workspaceId).listRunEvents(runId, {
          cursor: c.req.query("cursor"),
          limit: query.limit,
          waitSeconds: Number(c.req.query("waitSeconds") ?? 0),
        }),
        request(c),
      );
    } catch (error) {
      return jsonError(c, error, request(c));
    }
  });
}
