import { createServer } from "node:http";
import { createDockerCliRuntime } from "./docker-runtime.js";
import { createSandboxService } from "./service.js";

const serviceToken = process.env.SANDBOX_SERVICE_TOKEN;
if (!serviceToken)
  throw new Error("SANDBOX_SERVICE_TOKEN is required; no unauthenticated mode exists.");

const runtime = createDockerCliRuntime({
  maxFileBytes: Number(process.env.SANDBOX_MAX_FILE_BYTES ?? 10 * 1024 * 1024),
  maxOutputBytes: Number(process.env.SANDBOX_MAX_OUTPUT_BYTES ?? 2 * 1024 * 1024),
});
const handler = createSandboxService({ runtime, serviceToken });
const server = createServer((request, response) => {
  void handler(request, response);
});
const port = Number(process.env.PORT ?? 8790);
server.listen(port, "127.0.0.1", () => {
  console.log(`OpenMuse sandbox service listening on http://127.0.0.1:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
