import { describe, expect, it } from "vitest";
import { ApprovalService, InMemoryApprovalStore, ProviderRegistry, type ApprovalDigest } from "../src/index.js";
import { createFakeModelDriver } from "@openmuse/provider-testkit";

const fixedDigest: ApprovalDigest = { digest: async (value) => `digest:${JSON.stringify(value)}` };

describe("core provider registry", () => {
  it("creates one scoped provider instance and closes it", async () => {
    const registry = new ProviderRegistry();
    const driver = createFakeModelDriver();
    registry.register(driver);
    const scope = registry.createScope({ scopeId: "scope-1", signal: new AbortController().signal });
    const first = await scope.resolve("model-instance-1", "model", "fake-model", { defaultModel: "fake-model" }, { configDigest: "config-1" });
    const second = await scope.resolve("model-instance-1", "model", "fake-model", { defaultModel: "fake-model" }, { configDigest: "config-1" });
    expect(first).toBe(second);
    registry.assertCapability("model", "fake-model", "generate");
    await scope.close();
  });

  it("isolates two instances of the same provider and rejects config reuse", async () => {
    const registry = new ProviderRegistry();
    registry.register(createFakeModelDriver());
    const scope = registry.createScope();
    const first = await scope.resolve("instance-a", "model", "fake-model", { defaultModel: "one" }, { configDigest: "digest-a" });
    const second = await scope.resolve("instance-b", "model", "fake-model", { defaultModel: "two" }, { configDigest: "digest-b" });
    expect(first).not.toBe(second);
    await expect(scope.resolve("instance-a", "model", "fake-model", { defaultModel: "two" }, { configDigest: "digest-b" })).rejects.toThrow("cannot be reused");
    await scope.close();
  });

  it("allows a failed provider create to be retried", async () => {
    const base = createFakeModelDriver();
    let attempts = 0;
    const driver = {
      ...base,
      async create(config: Parameters<typeof base.create>[0], context: Parameters<typeof base.create>[1]) {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary failure");
        return base.create(config, context);
      },
    };
    const registry = new ProviderRegistry();
    registry.register(driver);
    const scope = registry.createScope();
    await expect(scope.resolve("retry-instance", "model", "fake-model", { defaultModel: "fake" }, { configDigest: "retry" })).rejects.toThrow();
    await expect(scope.resolve("retry-instance", "model", "fake-model", { defaultModel: "fake" }, { configDigest: "retry" })).resolves.toBeDefined();
    expect(attempts).toBe(2);
    await scope.close();
  });

  it("waits for creation while closing and rejects new resolutions", async () => {
    const base = createFakeModelDriver();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const driver = {
      ...base,
      async create(config: Parameters<typeof base.create>[0], context: Parameters<typeof base.create>[1]) {
        await gate;
        return base.create(config, context);
      },
    };
    const registry = new ProviderRegistry();
    registry.register(driver);
    const scope = registry.createScope();
    const resolving = scope.resolve("closing-instance", "model", "fake-model", { defaultModel: "fake" }, { configDigest: "closing" });
    const closing = scope.close();
    release();
    await resolving;
    await closing;
    await expect(scope.resolve("after-close", "model", "fake-model", { defaultModel: "fake" })).rejects.toThrow("scope is closed");
  });
});

describe("approval service", () => {
  it("binds approval to its digest and consumes it once", async () => {
    const store = new InMemoryApprovalStore();
    const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };
    const service = new ApprovalService(store, fixedDigest, clock, { next: () => "nonce-1" });
    const issued = await service.issue("approval-1", {
      tenantId: "tenant-1",
      workspaceId: "workspace-1",
      actorUserId: "user-1",
      runId: "run-1",
      toolCallId: "tool-1",
      canonicalArguments: { eventId: "event-1" },
      targetResources: { calendarId: "calendar-1" },
      connectionId: "connection-1",
      policyVersion: "v1",
    }, {
      expiresAt: "2026-01-01T00:05:00.000Z",
      allowedOperations: ["calendar.create"],
    });
    await service.decide("approval-1", issued.digest, "approve");
    const binding = issued.binding;
    await expect(service.consume("approval-1", binding)).resolves.toMatchObject({ status: "consumed" });
    await expect(service.consume("approval-1", binding)).rejects.toThrow("invalid or has already been used");
  });

  it("rejects changed execution arguments and expires before consumption", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const clock = { now: () => new Date(now) };
    const store = new InMemoryApprovalStore();
    const service = new ApprovalService(store, fixedDigest, clock, { next: () => "nonce-2" });
    const binding = {
      tenantId: "tenant-1", workspaceId: "workspace-1", actorUserId: "user-1", runId: "run-2", toolCallId: "tool-2",
      canonicalArguments: { eventId: "event-2" }, targetResources: { calendarId: "calendar-1" }, policyVersion: "v1",
    };
    const issued = await service.issue("approval-2", binding, {
      expiresAt: "2026-01-01T00:01:00.000Z", allowedOperations: ["calendar.create"],
    });
    await service.decide("approval-2", issued.digest, "approve");
    await expect(service.consume("approval-2", { ...binding, canonicalArguments: { eventId: "changed" } })).rejects.toThrow("does not match");
    now = new Date("2026-01-01T00:02:00.000Z");
    await expect(service.consume("approval-2", binding)).rejects.toThrow("expired");
  });

  it("allows only one concurrent decision", async () => {
    const store = new InMemoryApprovalStore();
    const service = new ApprovalService(store, fixedDigest, { now: () => new Date("2026-01-01T00:00:00.000Z") }, { next: () => "nonce-3" });
    const binding = {
      tenantId: "tenant-1", workspaceId: "workspace-1", actorUserId: "user-1", runId: "run-3", toolCallId: "tool-3",
      canonicalArguments: {}, targetResources: {}, policyVersion: "v1",
    };
    const issued = await service.issue("approval-3", binding, {
      expiresAt: "2026-01-01T00:05:00.000Z", allowedOperations: ["calendar.create"],
    });
    const decisions = await Promise.allSettled([
      service.decide("approval-3", issued.digest, "approve"),
      service.decide("approval-3", issued.digest, "deny"),
    ]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
