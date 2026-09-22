import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { ProviderCreateContext, ProviderOperationContext } from "@openmuse/provider-contracts";
import {
  createDockerSandboxDriver,
  createHttpDockerRuntime,
} from "@openmuse/provider-sandbox-docker";
import { createDockerCliRuntime } from "../src/docker-runtime.js";
import { createSandboxService } from "../src/service.js";

const image = "alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";
const enabled = process.env.OPENMUSE_DOCKER_SMOKE === "1";

function createContext(): ProviderCreateContext {
  return {
    signal: new AbortController().signal,
    scopeId: "docker-smoke",
    workspaceId: "docker-smoke-workspace",
  };
}

function operation(operationId: string): ProviderOperationContext {
  return {
    signal: new AbortController().signal,
    operationId,
    workspaceId: "docker-smoke-workspace",
  };
}

describe("Docker disposable integration", () => {
  it.skipIf(!enabled)(
    "creates, executes, writes, reads, cancels, and destroys a real container",
    async () => {
      const runtime = createDockerCliRuntime({
        maxFileBytes: 64 * 1024,
        maxOutputBytes: 64 * 1024,
      });
      const driver = createDockerSandboxDriver({ runtime });
      const client = await driver.create(
        { allowedImages: [image], maxSeconds: 10 },
        createContext(),
      );
      const sandbox = await client.create({ image }, operation("create"));
      try {
        await sandbox.writeFile(
          { path: "/workspace/fixture.txt", bytes: new TextEncoder().encode("hello") },
          operation("write"),
        );
        const bytes = await sandbox.readFile("/workspace/fixture.txt", operation("read"));
        expect([...bytes]).toEqual([104, 101, 108, 108, 111]);
        await expect(
          sandbox.execute({ argv: ["cat", "/workspace/fixture.txt"] }, operation("exec")),
        ).resolves.toMatchObject({ stdout: "hello", exitCode: 0 });
        await expect(
          sandbox.execute(
            { argv: ["sh", "-c", "sleep 5"], timeoutSeconds: 1 },
            operation("cancel"),
          ),
        ).resolves.toMatchObject({ timedOut: true, exitCode: 124 });
        await expect(
          sandbox.writeFile(
            { path: "/workspace/../escape", bytes: new Uint8Array([1]) },
            operation("bad-path"),
          ),
        ).rejects.toMatchObject({ code: "invalid_request" });
      } finally {
        await sandbox.destroy(operation("destroy"));
        await client.close();
      }
    },
    30_000,
  );

  it.skipIf(!enabled)(
    "performs the same lifecycle through the authenticated service boundary",
    async () => {
      const token = "docker-smoke-service-token";
      const server = createServer(
        (request, response) =>
          void createSandboxService({
            runtime: createDockerCliRuntime({ maxFileBytes: 64 * 1024, maxOutputBytes: 64 * 1024 }),
            serviceToken: token,
          })(request, response),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("service did not bind");
      const runtime = createHttpDockerRuntime({
        endpoint: `http://127.0.0.1:${address.port}`,
        serviceToken: token,
        workspaceId: "docker-smoke-workspace",
      });
      const client = await createDockerSandboxDriver({ runtime }).create(
        { allowedImages: [image], maxSeconds: 10 },
        createContext(),
      );
      const sandbox = await client.create({ image }, operation("service-create"));
      try {
        await sandbox.writeFile(
          { path: "/workspace/service.txt", bytes: new TextEncoder().encode("service") },
          operation("service-write"),
        );
        await expect(
          sandbox.execute({ argv: ["cat", "/workspace/service.txt"] }, operation("service-exec")),
        ).resolves.toMatchObject({ stdout: "service", exitCode: 0 });
        await expect(
          sandbox.execute(
            { argv: ["sh", "-c", "sleep 5"], timeoutSeconds: 1 },
            operation("service-cancel"),
          ),
        ).resolves.toMatchObject({ timedOut: true, exitCode: 124 });
      } finally {
        await sandbox.destroy(operation("service-destroy"));
        await client.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    30_000,
  );
});
