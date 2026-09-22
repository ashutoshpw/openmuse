import { createServer } from "node:http";
import { createDockerCliRuntime } from "./docker-runtime.js";
import { createSandboxService } from "./service.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a finite positive number.`);
  return value;
}

const serviceToken = requiredEnv("SANDBOX_SERVICE_TOKEN");
const workspaceId = requiredEnv("SANDBOX_WORKSPACE_ID");
const providerId = requiredEnv("SANDBOX_PROVIDER_ID");
const instanceId = requiredEnv("SANDBOX_INSTANCE_ID");
const allowedImages = requiredEnv("SANDBOX_ALLOWED_IMAGES")
  .split(",")
  .map((image) => image.trim())
  .filter(Boolean);
if (allowedImages.length === 0) throw new Error("SANDBOX_ALLOWED_IMAGES must not be empty.");
const userId = process.env.SANDBOX_USER_ID?.trim() || undefined;
const maxFileBytes = positiveEnv("SANDBOX_MAX_FILE_BYTES", 10 * 1024 * 1024);
const maxOutputBytes = positiveEnv("SANDBOX_MAX_OUTPUT_BYTES", 2 * 1024 * 1024);
const maxExecSeconds = positiveEnv("SANDBOX_MAX_EXEC_SECONDS", 15 * 60);
const requestTimeoutMs = positiveEnv("SANDBOX_REQUEST_TIMEOUT_MS", (maxExecSeconds + 30) * 1000);

const runtime = createDockerCliRuntime({
  instanceId,
  maxFileBytes,
  maxOutputBytes,
});
const handler = createSandboxService({
  runtime,
  serviceToken,
  workspaceId,
  providerId,
  instanceId,
  ...(userId ? { userId } : {}),
  allowedImages,
  maxFileBytes,
  maxExecSeconds,
  requestTimeoutMs,
});
const server = createServer((request, response) => {
  void handler(request, response);
});
const port = positiveEnv("PORT", 8790);
server.listen(port, "127.0.0.1", () => {
  console.log(`OpenMuse sandbox service listening on http://127.0.0.1:${port}`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.closeIdleConnections?.();
  server.close(() => process.exit(0));
};
server.on("error", (error) => {
  console.error("OpenMuse sandbox service listener failed:", error);
  shutdown();
});
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
