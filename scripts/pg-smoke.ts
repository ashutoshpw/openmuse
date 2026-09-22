import { createDatabase } from "@openmuse/db";

const runtimeUrl = process.env.DATABASE_URL;
const workerUrl = process.env.WORKER_DATABASE_URL ?? runtimeUrl;
const authUrl = process.env.AUTH_DATABASE_URL;
if (!runtimeUrl) throw new Error("DATABASE_URL is required for the PostgreSQL smoke test");
if (!workerUrl) throw new Error("WORKER_DATABASE_URL is required for the PostgreSQL smoke test");

const runtime = createDatabase({ url: runtimeUrl, maxConnections: 2 });
const worker = createDatabase({ url: workerUrl, maxConnections: 2 });
const auth = authUrl ? createDatabase({ url: authUrl, maxConnections: 2 }) : undefined;
try {
  const [role] = await runtime.sql<
    { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
  >`
    select current_user, r.rolsuper, r.rolbypassrls
    from pg_roles r
    where r.rolname = current_user
  `;
  if (!role) throw new Error("The runtime role could not be inspected");
  if (role.rolsuper || role.rolbypassrls)
    throw new Error("The runtime role must not be a superuser or BYPASSRLS role");

  const [{ protectedTables }] = await runtime.sql<{ protectedTables: number }[]>`
    select count(*)::int as "protectedTables"
    from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity
  `;
  if (protectedTables < 20)
    throw new Error(`Expected tenant RLS on at least 20 tables, found ${protectedTables}`);

  await runtime.sql.begin(async (transaction) => {
    await transaction`select set_config('app.workspace_id', 'missing-workspace', true)`;
    await transaction`select set_config('app.actor_id', 'missing-actor', true)`;
    const rows = await transaction`select id from workspaces`;
    if (rows.length !== 0) throw new Error("RLS returned rows without a valid membership context");
  });

  await worker.sql`select * from openmuse_discover_pending_task_scopes(1)`;
  if (auth) {
    const [authRole] = await auth.sql<
      { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]
    >`
      select current_user, r.rolsuper, r.rolbypassrls
      from pg_roles r
      where r.rolname = current_user
    `;
    if (!authRole) throw new Error("The auth role could not be inspected");
    if (authRole.rolsuper || authRole.rolbypassrls)
      throw new Error("The auth role must not be a superuser or BYPASSRLS role");
    await auth.sql`select id from users limit 1`;
  }
  console.log(
    `PostgreSQL smoke passed for ${role.current_user}; ${protectedTables} tables use RLS.`,
  );
} finally {
  await Promise.all([runtime.close(), worker.close(), auth?.close()]);
}
