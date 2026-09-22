import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Sql } from "postgres";

const MIGRATION_TABLE = "openmuse_schema_migrations";

/**
 * Tiny migration runner used by both self-hosted bootstrap and tests. It uses
 * a PostgreSQL advisory lock, records only successful migrations, and never
 * runs two migration batches concurrently.
 */
export async function migrateDatabase(sql: Sql, migrationsDirectory: string): Promise<void> {
  await sql`create table if not exists ${sql(MIGRATION_TABLE)} (version text primary key, applied_at timestamptz not null default now())`;
  await sql`select pg_advisory_lock(hashtext('openmuse:migrations'))`;
  try {
    const files = (await readFileList(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const appliedRows = await sql<
      { version: string }[]
    >`select version from ${sql(MIGRATION_TABLE)}`;
    const applied = new Set(appliedRows.map((row) => row.version));
    for (const file of files) {
      const version = basename(file, ".sql");
      if (applied.has(version)) continue;
      const body = await readFile(file, "utf8");
      await sql.begin(async (transaction) => {
        await transaction.unsafe(body);
        await transaction`insert into ${transaction(MIGRATION_TABLE)} (version) values (${version})`;
      });
    }
  } finally {
    await sql`select pg_advisory_unlock(hashtext('openmuse:migrations'))`;
  }
}

async function readFileList(directory: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name));
}
