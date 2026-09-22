import { createDatabase } from "@openmuse/db";

const migrationUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationUrl) throw new Error("MIGRATION_DATABASE_URL is required for grants");

const runtimeRole = process.env.RUNTIME_DB_ROLE ?? "openmuse_runtime";
const workerRole = process.env.WORKER_DB_ROLE ?? "openmuse_worker";
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const client = createDatabase({ url: migrationUrl, maxConnections: 1 });
const sql = client.sql;

try {
  const [{ database }] = await sql<{ database: string }[]>`select current_database() as database`;
  const roles = [quoteIdentifier(runtimeRole), quoteIdentifier(workerRole)];
  await sql.unsafe(`grant connect on database ${quoteIdentifier(database)} to ${roles.join(", ")}`);
  await sql.unsafe(`grant usage on schema public to ${roles.join(", ")}`);
  await sql.unsafe(
    `grant select, insert, update, delete on all tables in schema public to ${roles.join(", ")}`,
  );
  await sql.unsafe(`grant usage, select on all sequences in schema public to ${roles.join(", ")}`);
  await sql.unsafe(
    `alter default privileges in schema public grant select, insert, update, delete on tables to ${roles.join(", ")}`,
  );
  await sql.unsafe(
    `alter default privileges in schema public grant usage, select on sequences to ${roles.join(", ")}`,
  );
  await sql.unsafe(
    `grant execute on function openmuse_accept_invite(text, text, text), openmuse_resolve_conversation_workspace(text, text) to ${quoteIdentifier(runtimeRole)}`,
  );
  await sql.unsafe(
    `grant execute on function openmuse_discover_pending_task_scopes(integer) to ${quoteIdentifier(workerRole)}`,
  );
  console.log(`Granted runtime and worker privileges in ${database}.`);
} finally {
  await client.close();
}
