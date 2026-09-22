import { createOpenMuseAuth } from "@openmuse/auth";
import { createApiClient } from "../../../packages/client/src/index.js";
import {
  approvals,
  artifacts,
  conversations,
  conversationMembers,
  messages,
  providerCredentials,
  runEvents,
  runs,
  ScopedDatabase,
  workspaceMembers,
} from "@openmuse/db";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createApi } from "../src/app.js";
import {
  provisionIntegrationDatabase,
  type OpenMuseIntegrationHarness,
} from "./support/postgres.js";

const integration = Boolean(process.env.TEST_DATABASE_URL);
const tenantTables = [
  "workspaces",
  "workspace_members",
  "workspace_invites",
  "conversations",
  "conversation_members",
  "shared_snapshots",
  "shared_snapshot_grants",
  "messages",
  "runs",
  "run_events",
  "tasks",
  "task_leases",
  "approvals",
  "goals",
  "schedules",
  "memories",
  "connections",
  "artifacts",
  "provider_credentials",
  "audit_events",
  "idempotency_records",
] as const;

describe.skipIf(!integration)("OpenMuse API/auth PostgreSQL integration", () => {
  let harness: OpenMuseIntegrationHarness;
  let api: ReturnType<typeof createApi>;
  let auth: ReturnType<typeof createOpenMuseAuth>;
  let bearerToken = "";
  let cookie = "";

  const origin = "http://localhost:5173";
  const authSecret = "openmuse-integration-secret-2026-contains-32-bytes";

  beforeAll(async () => {
    harness = await provisionIntegrationDatabase();
    auth = createOpenMuseAuth(harness.auth, {
      secret: authSecret,
      baseURL: "http://localhost:8787",
      trustedOrigins: [origin],
      secureCookies: false,
      environment: "test",
    });
    api = createApi({ db: harness.runtime, auth, allowedOrigins: [origin] });
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it("keeps the migration owner separate from ordinary runtime roles", async () => {
    const roles = await harness.admin.sql<
      { rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]
    >`
      select rolname, rolsuper, rolbypassrls, rolcanlogin
      from pg_roles
      where rolname in (${harness.runtimeRole}, ${harness.authRole})
      order by rolname
    `;
    expect(roles).toHaveLength(2);
    expect(roles.every((role) => !role.rolsuper && !role.rolbypassrls && role.rolcanlogin)).toBe(
      true,
    );
    expect(roles.every((role) => role.rolname !== "postgres")).toBe(true);
    const [marker] = await harness.auth.sql<{ member: boolean }[]>`
      select pg_has_role(current_user, 'openmuse_auth_service', 'member') as member
    `;
    expect(marker?.member).toBe(true);
  });

  it("allows only one concurrent first-user bootstrap", async () => {
    const emptyHarness = await provisionIntegrationDatabase(undefined, { seed: false });
    try {
      const bootstrap = createOpenMuseAuth(emptyHarness.owner, {
        secret: authSecret,
        baseURL: "http://localhost:8787",
        trustedOrigins: [origin],
        bootstrapToken: "openmuse-bootstrap-token",
        secureCookies: false,
        environment: "test",
      });
      const outcomes = await Promise.allSettled([
        bootstrap.bootstrapFirstUser({
          token: "openmuse-bootstrap-token",
          email: `first-a-${emptyHarness.databaseName}@example.test`,
          password: harness.password,
        }),
        bootstrap.bootstrapFirstUser({
          token: "openmuse-bootstrap-token",
          email: `first-b-${emptyHarness.databaseName}@example.test`,
          password: harness.password,
        }),
      ]);
      const successful = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const users = await emptyHarness.owner.sql<{ count: string }[]>`
        select count(*)::text as count from users
      `;
      expect(successful).toHaveLength(1);
      expect(users[0]?.count).toBe("1");
    } finally {
      await emptyHarness.close();
    }
  });

  it("keeps the auth role unable to read tenant data even when it supplies tenant GUCs", async () => {
    const privileges = await Promise.all(
      tenantTables.map(async (table) => {
        const rows = await harness.auth.sql.begin(async (tx) => {
          await tx`
            select set_config('app.workspace_id', ${harness.ids.workspace}, true),
                   set_config('app.actor_id', ${harness.ids.userA}, true)
          `;
          return tx<{ allowed: boolean }[]>`
            select has_table_privilege(current_user, ${`public.${table}`}, 'select') as allowed
          `;
        });
        return { table, allowed: rows[0]?.allowed ?? false };
      }),
    );
    expect(privileges).toEqual(tenantTables.map((table) => ({ table, allowed: false })));

    const errors = await Promise.all(
      tenantTables.map(async (table) => {
        const result = await harness.auth.sql
          .begin(async (tx) => {
            await tx`
              select set_config('app.workspace_id', ${harness.ids.workspace}, true),
                     set_config('app.actor_id', ${harness.ids.userA}, true)
            `;
            return tx.unsafe(`select * from public."${table}" limit 1`);
          })
          .then(() => undefined)
          .catch((error: unknown) => error);
        return { table, error: result };
      }),
    );
    expect(errors).toEqual(
      tenantTables.map((table) => ({ table, error: expect.objectContaining({ code: "42501" }) })),
    );
  });

  it("does not allow an ordinary runtime role to self-enable auth-service access", async () => {
    const users = await harness.runtime.sql.begin(async (tx) => {
      await tx`select set_config('app.auth_service', 'true', true)`;
      return tx`select id from users order by id`;
    });
    expect(users).toHaveLength(0);
  });

  it("keeps Better Auth secrets hidden from the tenant role", async () => {
    const [sessions, accounts, verifications] = await harness.runtime.sql.begin(async (tx) => {
      await tx`
        select set_config('app.workspace_id', ${harness.ids.workspace}, true),
               set_config('app.actor_id', ${harness.ids.userA}, true),
               set_config('app.auth_service', 'true', true)
      `;
      return Promise.all([
        tx`select * from session`,
        tx`select * from account`,
        tx`select * from verification`,
      ]);
    });
    expect({
      sessions: sessions.length,
      accounts: accounts.length,
      verifications: verifications.length,
    }).toEqual({
      sessions: 0,
      accounts: 0,
      verifications: 0,
    });
  });

  it("denies a member from self-enrolling or elevating in an existing workspace", async () => {
    const scoped = new ScopedDatabase(harness.runtime.db, {
      workspaceId: harness.ids.workspace,
      actorId: harness.ids.userB,
    });

    const elevationError = await scoped
      .run((tx) =>
        tx.insert(workspaceMembers).values({
          workspaceId: harness.ids.workspace,
          userId: harness.ids.userB,
          role: "admin",
          status: "active",
          invitedBy: harness.ids.userB,
        }),
      )
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(elevationError).toMatchObject({ cause: { code: "42501" } });

    const visibleMemberships = await scoped.run((tx) =>
      tx
        .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
        .from(workspaceMembers),
    );
    expect(visibleMemberships).toEqual([{ userId: harness.ids.userB, role: "member" }]);
  });

  it("does not expose private conversation descendants through the tenant RLS boundary", async () => {
    const scoped = new ScopedDatabase(harness.runtime.db, {
      workspaceId: harness.ids.workspace,
      actorId: harness.ids.userB,
    });

    const [
      privateConversations,
      privateConversationMembers,
      privateMessages,
      privateRuns,
      privateEvents,
      privateApprovals,
      privateArtifacts,
    ] = await scoped.run(async (tx) =>
      Promise.all([
        tx.select().from(conversations),
        tx.select().from(conversationMembers),
        tx.select().from(messages),
        tx.select().from(runs),
        tx.select().from(runEvents),
        tx.select().from(approvals),
        tx.select().from(artifacts),
      ]),
    );

    const privateCredentials = await scoped.run((tx) => tx.select().from(providerCredentials));
    expect({
      conversations: privateConversations.length,
      conversationMembers: privateConversationMembers.length,
      messages: privateMessages.length,
      runs: privateRuns.length,
      runEvents: privateEvents.length,
      approvals: privateApprovals.length,
      artifacts: privateArtifacts.length,
      providerCredentials: privateCredentials.length,
    }).toEqual({
      conversations: 0,
      conversationMembers: 0,
      messages: 0,
      runs: 0,
      runEvents: 0,
      approvals: 0,
      artifacts: 0,
      providerCredentials: 0,
    });
  });

  it("rejects password lookup through the tenant role before actor context exists", async () => {
    const tenantRoleAuth = createOpenMuseAuth(harness.runtime, {
      secret: authSecret,
      baseURL: "http://localhost:8787",
      trustedOrigins: [origin],
      secureCookies: false,
      environment: "test",
    });
    const response = await tenantRoleAuth.handler(
      request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          email: `a-${harness.ids.userA}@example.test`,
          password: harness.password,
        }),
      }),
    );

    // This is the concrete shared-role failure: users_scope requires
    // app.actor_id, while Better Auth looks up users before that setting exists.
    expect(response.status).toBe(401);
  });

  it("supports bootstrap-seeded password sign-in and both cookie and bearer sessions", async () => {
    const signUp = await api.request(
      request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          name: "Should Not Sign Up",
          email: `new-${harness.ids.userA}@example.test`,
          password: harness.password,
        }),
      }),
    );
    expect(signUp.status).toBe(400);

    const signIn = await api.request(
      request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          email: `a-${harness.ids.userA}@example.test`,
          password: harness.password,
        }),
      }),
    );
    expect(signIn.status).toBe(200);
    const signInBody = (await signIn.json()) as { token?: string; user?: { id?: string } };
    expect(signInBody.user?.id).toBe(harness.ids.userA);
    expect(signInBody.token).toEqual(expect.any(String));
    bearerToken = signInBody.token ?? "";
    cookie = firstCookie(signIn.headers.get("set-cookie"));
    expect(cookie).toContain("=");

    const cookieSession = await api.request(
      request("/api/auth/get-session", { headers: { Origin: origin, Cookie: cookie } }),
    );
    expect(cookieSession.status).toBe(200);
    expect(((await cookieSession.json()) as { user?: { id?: string } }).user?.id).toBe(
      harness.ids.userA,
    );

    const bearerSession = await api.request(
      request("/api/auth/get-session", {
        headers: { Origin: origin, Authorization: `Bearer ${bearerToken}` },
      }),
    );
    expect(bearerSession.status).toBe(200);
    expect(((await bearerSession.json()) as { user?: { id?: string } }).user?.id).toBe(
      harness.ids.userA,
    );

    await expect(
      auth.getIdentity(request("/api/v1/workspaces", { headers: { Cookie: cookie } })),
    ).resolves.toMatchObject({ userId: harness.ids.userA });
    await expect(
      auth.getIdentity(
        request("/api/v1/workspaces", { headers: { Authorization: `Bearer ${bearerToken}` } }),
      ),
    ).resolves.toMatchObject({ userId: harness.ids.userA });
  });

  it("returns typed workspace envelopes and the current session through createApiClient", async () => {
    const client = createApiClient({
      baseUrl: "http://localhost:8787",
      getAccessToken: () => bearerToken,
      fetch: async (input, init) => api.request(input, init),
    });
    const workspaces = await client.listWorkspaces();
    expect(workspaces.items.map((item) => item.id)).toContain(harness.ids.workspace);

    const currentSession = await client.getCurrentSession();
    expect(currentSession.userId).toBe(harness.ids.userA);
    expect(currentSession.scopes).toContain("api");
  });
});

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost:8787${path}`, init);
}

function firstCookie(value: string | null): string {
  const first = value?.split(",")[0]?.split(";")[0]?.trim();
  return first ?? "";
}
