import { createDatabase } from "@openmuse/db";
import { createOpenMuseAuth } from "@openmuse/auth";
import { createApi } from "./app.js";

const databaseUrl = Bun.env.DATABASE_URL;
const authDatabaseUrl = Bun.env.AUTH_DATABASE_URL ?? databaseUrl;
const authSecret = Bun.env.AUTH_SECRET;
const authUrl = Bun.env.AUTH_URL ?? "http://localhost:8787";
const runtimeEnvironment =
  (Bun.env.NODE_ENV as "development" | "test" | "production" | undefined) ?? "development";
const webOrigins = (Bun.env.WEB_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!authDatabaseUrl) throw new Error("AUTH_DATABASE_URL is required");
if (runtimeEnvironment === "production" && !Bun.env.AUTH_DATABASE_URL)
  throw new Error("AUTH_DATABASE_URL is required in production");
if (!authSecret) throw new Error("AUTH_SECRET is required; no development bypass is available");

const db = createDatabase({ url: databaseUrl });
// Better Auth runs without a tenant context, so it must use a dedicated
// database role/pool. The API tenant pool must never gain the auth-service RLS
// exception merely because the auth adapter needs to create a session.
const authDb = createDatabase({
  url: authDatabaseUrl,
  maxConnections: Number(Bun.env.AUTH_DB_POOL ?? 4),
});
const auth = createOpenMuseAuth(authDb, {
  secret: authSecret,
  baseURL: authUrl,
  trustedOrigins: (Bun.env.AUTH_TRUSTED_ORIGINS ?? [authUrl, ...webOrigins].join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  environment: runtimeEnvironment,
  bootstrapToken: Bun.env.OPENMUSE_BOOTSTRAP_TOKEN,
});
const api = createApi({
  db,
  auth,
  allowedOrigins: webOrigins,
});

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 8787),
  fetch: api.fetch,
});
console.log(`OpenMuse API listening on ${server.url}`);

const shutdown = async () => {
  server.stop(true);
  await db.close();
  await authDb.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
