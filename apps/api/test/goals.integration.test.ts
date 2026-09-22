import { createOpenMuseAuth } from "@openmuse/auth";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";
import {
  provisionIntegrationDatabase,
  type OpenMuseIntegrationHarness,
} from "./support/postgres.js";

const integration = Boolean(process.env.TEST_DATABASE_URL);
const origin = "http://localhost:5173";
const authSecret = "openmuse-goals-integration-secret-2026-contains-32-bytes";

type Envelope<T = unknown> = {
  data?: T;
  error?: { code?: string; message?: string };
};

type GoalResource = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  title: string;
  instructions: string;
  revision: number;
  status: string;
  schedule: unknown;
  nextRunAt: string | null;
  connectionIds: string[];
  memoryIds: string[];
  approvalPolicyVersion: string;
};

describe.skipIf(!integration)("OpenMuse goal CRUD PostgreSQL integration", () => {
  let harness: OpenMuseIntegrationHarness;
  let api: ReturnType<typeof createApi>;
  let actorAToken = "";
  let actorBToken = "";
  let goalId = "";
  let connectionA = "";
  let connectionB = "";
  let memoryA = "";
  let memoryB = "";

  beforeAll(async () => {
    harness = await provisionIntegrationDatabase();
    api = createApi({
      db: harness.runtime,
      auth: createOpenMuseAuth(harness.auth, {
        secret: authSecret,
        baseURL: "http://localhost:8787",
        trustedOrigins: [origin],
        secureCookies: false,
        environment: "test",
      }),
      allowedOrigins: [origin],
    });
    currentApi = api;

    connectionA = `goal-connection-a-${harness.databaseName}`;
    connectionB = `goal-connection-b-${harness.databaseName}`;
    memoryA = `goal-memory-a-${harness.databaseName}`;
    memoryB = `goal-memory-b-${harness.databaseName}`;
    await harness.owner.sql.begin(async (tx) => {
      await tx`
        insert into connections
          (id, workspace_id, user_id, provider, external_account_id, status, scopes, metadata)
        values
          (${connectionA}, ${harness.ids.workspace}, ${harness.ids.userA}, 'goal-fixture', ${connectionA}, 'active', '[]'::jsonb, '{}'::jsonb),
          (${connectionB}, ${harness.ids.workspace}, ${harness.ids.userB}, 'goal-fixture', ${connectionB}, 'active', '[]'::jsonb, '{}'::jsonb)
      `;
      await tx`
        insert into memories
          (id, workspace_id, created_by, subject, content, metadata)
        values
          (${memoryA}, ${harness.ids.workspace}, ${harness.ids.userA}, 'Owner memory', 'owner memory fixture', '{"scope":"workspace","source":"user","sensitivity":"private","version":1}'::jsonb),
          (${memoryB}, ${harness.ids.workspace}, ${harness.ids.userB}, 'Member memory', 'member memory fixture', '{"scope":"workspace","source":"user","sensitivity":"private","version":1}'::jsonb)
      `;
    });

    actorAToken = await signIn(api, harness.ids.userA, harness);
    actorBToken = await signIn(api, harness.ids.userB, harness);
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it("persists validated schedule metadata and exposes bounded owner CRUD", async () => {
    const create = await requestJson<Envelope<GoalResource>>("/api/v1/goals", actorAToken, {
      method: "POST",
      body: {
        workspaceId: harness.ids.workspace,
        title: "Owner goal",
        instructions: "Review the owner's inbox every hour.",
        schedule: { kind: "interval", everySeconds: 3600, timezone: "UTC" },
        connectionIds: [connectionA],
        memoryIds: [memoryA],
      },
    });
    expect(create.response.status, JSON.stringify(create.body)).toBe(200);
    expect(create.body.data).toMatchObject({
      workspaceId: harness.ids.workspace,
      ownerUserId: harness.ids.userA,
      title: "Owner goal",
      revision: 1,
      status: "draft",
      schedule: { kind: "interval", everySeconds: 3600, timezone: "UTC" },
      nextRunAt: null,
      connectionIds: [connectionA],
      memoryIds: [memoryA],
      approvalPolicyVersion: "1",
    });
    goalId = create.body.data?.id ?? "";
    expect(goalId).toEqual(expect.any(String));

    const extraGoals = await Promise.all(
      ["Second owner goal", "Third owner goal"].map((title) =>
        requestJson<Envelope<GoalResource>>("/api/v1/goals", actorAToken, {
          method: "POST",
          body: {
            workspaceId: harness.ids.workspace,
            title,
            instructions: `${title} instructions`,
            schedule: null,
            connectionIds: [],
            memoryIds: [],
          },
        }),
      ),
    );
    expect(extraGoals.map(({ response }) => response.status)).toEqual([200, 200]);

    const get = await requestJson<Envelope<GoalResource>>(`/api/v1/goals/${goalId}`, actorAToken);
    expect(get.response.status).toBe(200);
    expect(get.body.data?.id).toBe(goalId);

    const firstPage = await requestJson<
      Envelope<{ items: GoalResource[]; page: { nextCursor: string | null; hasMore: boolean } }>
    >(`/api/v1/workspaces/${harness.ids.workspace}/goals?limit=1`, actorAToken);
    expect(firstPage.response.status).toBe(200);
    expect(firstPage.body.data?.items).toHaveLength(1);
    expect(firstPage.body.data?.page).toEqual({ nextCursor: "1", hasMore: true });

    const secondPage = await requestJson<
      Envelope<{ items: GoalResource[]; page: { nextCursor: string | null; hasMore: boolean } }>
    >(`/api/v1/workspaces/${harness.ids.workspace}/goals?limit=1&cursor=1`, actorAToken);
    expect(secondPage.response.status).toBe(200);
    expect(secondPage.body.data?.items).toHaveLength(1);
    expect(secondPage.body.data?.items[0]?.id).not.toBe(firstPage.body.data?.items[0]?.id);

    const [stored] = await harness.owner.sql<
      { revision: number; config: Record<string, unknown>; next_run_at: string | null }[]
    >`
      select revision, config, next_run_at
      from goals
      where id = ${goalId}
    `;
    expect(stored).toEqual({
      revision: 1,
      config: {
        schedule: { kind: "interval", everySeconds: 3600, timezone: "UTC" },
        connectionIds: [connectionA],
        memoryIds: [memoryA],
        approvalPolicyVersion: "1",
      },
      next_run_at: null,
    });

    const columns = await harness.owner.sql<
      { column_name: string; data_type: string; is_nullable: string }[]
    >`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'goals'
        and column_name in ('revision', 'config', 'next_run_at')
      order by column_name
    `;
    expect(columns).toEqual([
      { column_name: "config", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "next_run_at", data_type: "timestamp with time zone", is_nullable: "YES" },
      { column_name: "revision", data_type: "integer", is_nullable: "NO" },
    ]);

    const applied = await harness.owner.sql<{ version: string }[]>`
      select version from openmuse_schema_migrations order by version
    `;
    expect(applied.map((row) => row.version)).toContain("0011_goal_crud_safety");
  });

  it("enforces workspace binding, strict config, and owner-only references", async () => {
    const mismatch = await requestJson<Envelope>("/api/v1/goals", actorAToken, {
      method: "POST",
      body: {
        workspaceId: "workspace-does-not-match-scope",
        title: "Wrong workspace",
        instructions: "This must not be created.",
      },
    });
    expect(mismatch.response.status).toBe(404);
    expect(mismatch.body.error?.code).toBe("not_found");

    const unknownConfigField = await requestJson<Envelope>("/api/v1/goals", actorAToken, {
      method: "POST",
      body: {
        workspaceId: harness.ids.workspace,
        title: "Unknown field",
        instructions: "Strict parsing should reject this.",
        unexpected: true,
      },
    });
    expect(unknownConfigField.response.status).toBe(400);
    expect(unknownConfigField.body.error?.code).toBe("invalid_request");

    const invalidSchedule = await requestJson<Envelope>("/api/v1/goals", actorAToken, {
      method: "POST",
      body: {
        workspaceId: harness.ids.workspace,
        title: "Invalid schedule",
        instructions: "The cadence is below the supported minimum.",
        schedule: { kind: "interval", everySeconds: 5, timezone: "UTC" },
      },
    });
    expect(invalidSchedule.response.status).toBe(400);
    expect(invalidSchedule.body.error?.code).toBe("invalid_request");

    const foreignConnection = await requestJson<Envelope>("/api/v1/goals", actorAToken, {
      method: "POST",
      body: {
        workspaceId: harness.ids.workspace,
        title: "Foreign connection",
        instructions: "The connection belongs to another member.",
        connectionIds: [connectionB],
      },
    });
    expect(foreignConnection.response.status).toBe(403);
    expect(foreignConnection.body.error?.code).toBe("forbidden");

    const foreignMemory = await requestJson<Envelope>("/api/v1/goals", actorAToken, {
      method: "POST",
      body: {
        workspaceId: harness.ids.workspace,
        title: "Foreign memory",
        instructions: "The memory belongs to another member.",
        memoryIds: [memoryB],
      },
    });
    expect(foreignMemory.response.status).toBe(403);
    expect(foreignMemory.body.error?.code).toBe("forbidden");

    const duplicateReference = await requestJson<Envelope>("/api/v1/goals", actorAToken, {
      method: "POST",
      body: {
        workspaceId: harness.ids.workspace,
        title: "Duplicate reference",
        instructions: "References must be unique.",
        connectionIds: [connectionA, connectionA],
      },
    });
    expect(duplicateReference.response.status).toBe(400);
    expect(duplicateReference.body.error?.code).toBe("invalid_request");
  });

  it("supports owner updates and status transitions with revision CAS", async () => {
    const update = await requestJson<Envelope<GoalResource>>(
      `/api/v1/goals/${goalId}`,
      actorAToken,
      {
        method: "PATCH",
        body: {
          expectedRevision: 1,
          title: "Owner goal updated",
          schedule: { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
        },
      },
    );
    expect(update.response.status, JSON.stringify(update.body)).toBe(200);
    expect(update.body.data).toMatchObject({
      title: "Owner goal updated",
      revision: 2,
      schedule: { kind: "cron", expression: "0 * * * *", timezone: "UTC" },
      connectionIds: [connectionA],
      memoryIds: [memoryA],
      nextRunAt: null,
    });

    const status = await requestJson<Envelope<GoalResource>>(
      `/api/v1/goals/${goalId}/status`,
      actorAToken,
      { method: "POST", body: { expectedRevision: 2, status: "active" } },
    );
    expect(status.response.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body.data).toMatchObject({ status: "active", revision: 3 });
  });

  it("allows only one concurrent update and one concurrent status change per revision", async () => {
    const updates = await Promise.all([
      requestJson<Envelope<GoalResource>>(`/api/v1/goals/${goalId}`, actorAToken, {
        method: "PATCH",
        body: { expectedRevision: 3, title: "CAS update A" },
      }),
      requestJson<Envelope<GoalResource>>(`/api/v1/goals/${goalId}`, actorAToken, {
        method: "PATCH",
        body: { expectedRevision: 3, title: "CAS update B" },
      }),
    ]);
    expect(updates.map(({ response }) => response.status).toSorted()).toEqual([200, 409]);
    expect(updates.filter(({ response }) => response.status === 409)[0]?.body.error?.code).toBe(
      "conflict",
    );

    const statuses = await Promise.all([
      requestJson<Envelope<GoalResource>>(`/api/v1/goals/${goalId}/status`, actorAToken, {
        method: "POST",
        body: { expectedRevision: 4, status: "paused" },
      }),
      requestJson<Envelope<GoalResource>>(`/api/v1/goals/${goalId}/status`, actorAToken, {
        method: "POST",
        body: { expectedRevision: 4, status: "completed" },
      }),
    ]);
    expect(statuses.map(({ response }) => response.status).toSorted()).toEqual([200, 409]);
    expect(statuses.filter(({ response }) => response.status === 409)[0]?.body.error?.code).toBe(
      "conflict",
    );
  });

  it("keeps a workspace member from listing, resolving, or mutating another owner's goal", async () => {
    const list = await requestJson<
      Envelope<{ items: GoalResource[]; page: { nextCursor: string | null; hasMore: boolean } }>
    >(`/api/v1/workspaces/${harness.ids.workspace}/goals`, actorBToken);
    expect(list.response.status).toBe(200);
    expect(list.body.data).toEqual({ items: [], page: { nextCursor: null, hasMore: false } });

    const requests = await Promise.all([
      requestJson<Envelope>(`/api/v1/goals/${goalId}`, actorBToken),
      requestJson<Envelope>(`/api/v1/goals/${goalId}`, actorBToken, {
        method: "PATCH",
        body: { expectedRevision: 5, title: "Member takeover" },
      }),
      requestJson<Envelope>(`/api/v1/goals/${goalId}/status`, actorBToken, {
        method: "POST",
        body: { expectedRevision: 5, status: "active" },
      }),
    ]);
    expect(requests.map(({ response }) => response.status)).toEqual([404, 404, 404]);
    expect(requests.every(({ body }) => body.error?.code === "not_found")).toBe(true);

    const [memberRows] = await harness.runtime.sql.begin(async (tx) => {
      await tx`
        select set_config('app.workspace_id', ${harness.ids.workspace}, true),
               set_config('app.actor_id', ${harness.ids.userB}, true)
      `;
      return Promise.all([
        tx<{ id: string }[]>`select id from goals where id = ${goalId}`,
        tx<{ workspace_id: string | null }[]>`
          select openmuse_resolve_resource_workspace('goal', ${goalId}, ${harness.ids.userB}) as workspace_id
        `,
      ]);
    });
    expect(memberRows).toEqual([]);

    const [resolvedForOwner] = await harness.runtime.sql`
      select openmuse_resolve_resource_workspace('goal', ${goalId}, ${harness.ids.userA}) as workspace_id
    `;
    expect(resolvedForOwner?.workspace_id).toBe(harness.ids.workspace);

    const [policy] = await harness.owner.sql<
      { relrowsecurity: boolean; policyname: string; qual: string; with_check: string }[]
    >`
      select c.relrowsecurity, p.policyname, p.qual, p.with_check
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
      where n.nspname = 'public' and c.relname = 'goals' and p.policyname = 'goals_scope'
    `;
    expect(policy?.relrowsecurity).toBe(true);
    expect(policy?.qual).toContain("created_by = openmuse_actor_id()");
    expect(policy?.with_check).toContain("created_by = openmuse_actor_id()");
  });
});

async function signIn(
  api: ReturnType<typeof createApi>,
  userId: string,
  harness: OpenMuseIntegrationHarness,
): Promise<string> {
  const prefix = userId === harness.ids.userA ? "a-" : "b-";
  const response = await api.request(
    request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        email: `${prefix}${userId}@example.test`,
        password: harness.password,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token?: string };
  expect(body.token).toEqual(expect.any(String));
  return body.token ?? "";
}

async function requestJson<T>(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ response: Response; body: T }> {
  const response = await currentApi!.request(
    request(path, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  return { response, body: (await response.json()) as T };
}

let currentApi: ReturnType<typeof createApi> | undefined;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost:8787${path}`, init);
}
