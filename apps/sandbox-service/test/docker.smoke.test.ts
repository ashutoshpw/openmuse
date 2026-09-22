import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import type { ProviderCreateContext, ProviderOperationContext } from "@openmuse/provider-contracts";
import {
  createDockerSandboxDriver,
  createHttpDockerRuntime,
} from "@openmuse/provider-sandbox-docker";
import { createDockerCliRuntime } from "../src/docker-runtime.js";
import { createSandboxService } from "../src/service.js";

const image =
  "ghcr.io/astral-sh/uv@sha256:4f5d923c9dcea037f57bda425dd209f3ec643da2f0b74227f68d09dab0b3bb36";
const enabled = process.env.OPENMUSE_DOCKER_SMOKE === "1";
const required = process.env.OPENMUSE_SMOKE_REQUIRED === "1";
const providerId = "sandbox-docker";
const instanceId = `docker-smoke-${process.pid}`;
const serviceSecret = "docker-smoke-service-secret";

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
  (enabled || required ? it : it.skipIf(true))(
    "creates, executes, writes, reads, cancels, and destroys a real container",
    async () => {
      const runtime = createDockerCliRuntime({
        instanceId,
        maxFileBytes: 64 * 1024,
        maxOutputBytes: 64 * 1024,
      });
      const driver = createDockerSandboxDriver({ runtime, instanceId });
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
        const mediumBytes = Uint8Array.from({ length: 193 }, (_, index) => index % 251);
        await sandbox.writeFile(
          { path: "/workspace/medium.bin", bytes: mediumBytes },
          operation("medium-write"),
        );
        const mediumRead = await sandbox.readFile(
          "/workspace/medium.bin",
          operation("medium-read"),
        );
        expect([...mediumRead]).toEqual([...mediumBytes]);
        await expect(
          sandbox.execute(
            { argv: ["ln", "-s", "fixture.txt", "/workspace/file-link"] },
            operation("symlink-create"),
          ),
        ).resolves.toMatchObject({ exitCode: 0 });
        await expect(
          sandbox.readFile("/workspace/file-link", operation("symlink-read")),
        ).rejects.toThrow();
        await expect(
          sandbox.writeFile(
            { path: "/workspace/file-link", bytes: new TextEncoder().encode("unsafe") },
            operation("symlink-write"),
          ),
        ).rejects.toThrow();
        await expect(
          sandbox.execute(
            { argv: ["ln", "-s", "/tmp", "/workspace/parent-link"] },
            operation("parent-symlink-create"),
          ),
        ).resolves.toMatchObject({ exitCode: 0 });
        await expect(
          sandbox.writeFile(
            { path: "/workspace/parent-link/escape", bytes: new Uint8Array([1]) },
            operation("parent-symlink-write"),
          ),
        ).rejects.toThrow();
        await expect(
          sandbox.execute(
            {
              argv: [
                "sh",
                "-c",
                "printf safe >/tmp/openmuse-escape-marker; rm -rf /workspace/race; mkdir /workspace/race; (for i in $(seq 1 20000); do rm -rf /workspace/race; mkdir /workspace/race 2>/dev/null || true; if [ $((i % 2)) -eq 0 ]; then rm -rf /workspace/race; ln -s /tmp /workspace/race 2>/dev/null || true; else ln -s /tmp/openmuse-escape-marker /workspace/race/escape-marker 2>/dev/null || true; fi; done) >/dev/null 2>&1 &",
              ],
            },
            operation("symlink-race-start"),
          ),
        ).resolves.toMatchObject({ exitCode: 0 });
        await Promise.all(
          Array.from({ length: 64 }, (_, index) =>
            sandbox
              .writeFile(
                {
                  path: "/workspace/race/escape-marker",
                  bytes: new TextEncoder().encode(`attempt-${index}`),
                },
                operation(`symlink-race-write-${index}`),
              )
              .catch(() => undefined),
          ),
        );
        await expect(
          sandbox.execute(
            { argv: ["sleep", "1"], timeoutSeconds: 2 },
            operation("symlink-race-wait"),
          ),
        ).resolves.toMatchObject({ exitCode: 0 });
        await expect(
          sandbox.execute(
            { argv: ["cat", "/tmp/openmuse-escape-marker"] },
            operation("symlink-race-check"),
          ),
        ).resolves.toMatchObject({ stdout: "safe", exitCode: 0 });
        await expect(
          sandbox.writeFile(
            { path: "/workspace/../escape", bytes: new Uint8Array([1]) },
            operation("bad-path"),
          ),
        ).rejects.toMatchObject({ code: "invalid_request" });
        const timedOutContainer = sandbox.id;
        await expect(
          sandbox.execute(
            { argv: ["sh", "-c", "sleep 3; touch /workspace/late-marker"], timeoutSeconds: 1 },
            operation("cancel"),
          ),
        ).resolves.toMatchObject({ timedOut: true, exitCode: 124 });
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        await expect(
          runtime.get(timedOutContainer, new AbortController().signal),
        ).rejects.toThrow();
      } finally {
        await sandbox.destroy(operation("destroy"));
        await client.close();
      }
    },
    60_000,
  );

  (enabled || required ? it : it.skipIf(true))(
    "performs the same lifecycle through the authenticated service boundary",
    async () => {
      const token = serviceSecret;
      const server = createServer(
        (request, response) =>
          void createSandboxService({
            runtime: createDockerCliRuntime({
              instanceId,
              maxFileBytes: 64 * 1024,
              maxOutputBytes: 64 * 1024,
            }),
            serviceToken: token,
            workspaceId: "docker-smoke-workspace",
            providerId,
            instanceId,
            allowedImages: [image],
            maxExecSeconds: 10,
          })(request, response),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("service did not bind");
      const runtime = createHttpDockerRuntime({
        endpoint: `http://127.0.0.1:${address.port}`,
        serviceToken: token,
        workspaceId: "docker-smoke-workspace",
        providerId,
        instanceId,
      });
      const client = await createDockerSandboxDriver({ runtime, instanceId }).create(
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
        const mediumBytes = Uint8Array.from({ length: 193 }, (_, index) => index % 251);
        await sandbox.writeFile(
          { path: "/workspace/service-medium.bin", bytes: mediumBytes },
          operation("service-medium-write"),
        );
        const serviceMediumRead = await sandbox.readFile(
          "/workspace/service-medium.bin",
          operation("service-medium-read"),
        );
        expect([...serviceMediumRead]).toEqual([...mediumBytes]);
        await expect(
          sandbox.execute(
            { argv: ["ln", "-s", "service.txt", "/workspace/service-link"] },
            operation("service-symlink-create"),
          ),
        ).resolves.toMatchObject({ exitCode: 0 });
        await expect(
          sandbox.writeFile(
            { path: "/workspace/service-link", bytes: new TextEncoder().encode("unsafe") },
            operation("service-symlink-write"),
          ),
        ).rejects.toThrow();
        const timedOutContainer = sandbox.id;
        await expect(
          sandbox.execute(
            { argv: ["sh", "-c", "sleep 3; touch /workspace/late-marker"], timeoutSeconds: 1 },
            operation("service-cancel"),
          ),
        ).resolves.toMatchObject({ timedOut: true, exitCode: 124 });
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        await expect(
          runtime.get(timedOutContainer, new AbortController().signal),
        ).rejects.toThrow();
      } finally {
        await sandbox.destroy(operation("service-destroy"));
        await client.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    60_000,
  );
});
