import { randomUUID } from "node:crypto";
import { createOpenMuseAuth } from "@openmuse/auth";
import { createDatabase, ScopedDatabase, WorkspaceRepository } from "@openmuse/db";

const databaseUrl = Bun.env.DATABASE_URL;
const authDatabaseUrl = Bun.env.AUTH_DATABASE_URL;
const authSecret = Bun.env.AUTH_SECRET;
const bootstrapToken = Bun.env.OPENMUSE_BOOTSTRAP_TOKEN;
const email = Bun.env.OPENMUSE_BOOTSTRAP_EMAIL;
const password = Bun.env.OPENMUSE_BOOTSTRAP_PASSWORD;
const name = Bun.env.OPENMUSE_BOOTSTRAP_NAME;
const workspaceName = Bun.env.OPENMUSE_BOOTSTRAP_WORKSPACE ?? "Personal workspace";
const authUrl = Bun.env.AUTH_URL ?? "http://localhost:8787";
const webOrigins = (Bun.env.WEB_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!authDatabaseUrl) throw new Error("AUTH_DATABASE_URL is required");
if (!authSecret) throw new Error("AUTH_SECRET is required");
if (!bootstrapToken) throw new Error("OPENMUSE_BOOTSTRAP_TOKEN is required");
if (!email) throw new Error("OPENMUSE_BOOTSTRAP_EMAIL is required");
if (!password) throw new Error("OPENMUSE_BOOTSTRAP_PASSWORD is required");

const authDb = createDatabase({
  url: authDatabaseUrl,
  maxConnections: 2,
});
const runtimeDb = createDatabase({
  url: databaseUrl,
  maxConnections: 2,
});
try {
  const auth = createOpenMuseAuth(authDb, {
    secret: authSecret,
    baseURL: authUrl,
    trustedOrigins: [authUrl, ...webOrigins],
    bootstrapToken,
    environment: "development",
  });
  const user = await auth.bootstrapFirstUser({
    token: bootstrapToken,
    email,
    password,
    ...(name?.trim() ? { name: name.trim() } : {}),
  });
  const workspaceId = randomUUID();
  await new WorkspaceRepository(
    new ScopedDatabase(runtimeDb.db, { workspaceId, actorId: user.id }),
  ).create({
    id: workspaceId,
    name: workspaceName.trim() || "Personal workspace",
    slug: `${
      (workspaceName.trim() || "workspace")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "workspace"
    }-${workspaceId.slice(0, 8)}`,
  });
  console.log(JSON.stringify({ userId: user.id, email: user.email, workspaceId }));
} finally {
  await runtimeDb.close();
  await authDb.close();
}
