import { createDatabase, PendingTaskScopeRepository } from "@openmuse/db";
import { ConversationTaskHandler } from "@openmuse/application";
import { DurableWorker } from "./runner.js";
import { WorkerProviderRuntime } from "./providers.js";

const databaseUrl = Bun.env.DATABASE_URL;
const workspaceId = Bun.env.WORKER_WORKSPACE_ID;
const actorId = Bun.env.WORKER_ACTOR_ID;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if ((workspaceId && !actorId) || (!workspaceId && actorId))
  throw new Error("WORKER_WORKSPACE_ID and WORKER_ACTOR_ID must be provided together");

const db = createDatabase({
  url: databaseUrl,
  maxConnections: Number(Bun.env.WORKER_DB_POOL ?? 4),
});
const trustedEndpoints = (Bun.env.PROVIDER_TRUSTED_ENDPOINTS ?? "")
  .split(",")
  .map((endpoint) => endpoint.trim())
  .filter(Boolean);
const pendingScopes = new PendingTaskScopeRepository(db.db);
const providerRuntime = new WorkerProviderRuntime({
  db: db.db,
  encryptionKey: Bun.env.CREDENTIAL_ENCRYPTION_KEY,
  deterministic: Bun.env.WORKER_DETERMINISTIC_MODEL === "true",
  deterministicResponse: Bun.env.WORKER_DETERMINISTIC_RESPONSE,
  endpointPolicy: { trustedEndpoints },
});
const conversationHandler = new ConversationTaskHandler({
  db: db.db,
  resolveModel: (payload, context, task) => providerRuntime.resolveModel(payload, context, task),
});
const worker = new DurableWorker(db, {
  workerId: Bun.env.WORKER_ID ?? `worker-${crypto.randomUUID()}`,
  scopes: workspaceId && actorId ? [{ workspaceId, actorId }] : [],
  discoverScopes: () => pendingScopes.discover(Number(Bun.env.WORKER_SCOPE_LIMIT ?? 100)),
  handlers: [conversationHandler],
});
const shutdown = () => worker.stop("shutdown");
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
await worker.run();
await db.close();
