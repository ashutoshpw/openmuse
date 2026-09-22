import { join } from "node:path";
import { createDatabase, migrateDatabase } from "@openmuse/db";

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("MIGRATION_DATABASE_URL (or DATABASE_URL) is required");

const client = createDatabase({ url, maxConnections: 2 });
try {
  const directory =
    process.env.MIGRATIONS_DIRECTORY ?? join(process.cwd(), "packages/db/migrations");
  await migrateDatabase(client.sql, directory);
  console.log(`Applied migrations from ${directory}.`);
} finally {
  await client.close();
}
