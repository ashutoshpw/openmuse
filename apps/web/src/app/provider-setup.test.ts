import type { ProviderInstance } from "@openmuse/contracts";
import { describe, expect, it, vi } from "vitest";
import { saveProviderSetup } from "./provider-setup";

function provider(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: "provider-1",
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    workspaceId: null,
    scope: "system",
    ownerUserId: null,
    providerId: "openai",
    module: "model",
    displayName: "OpenAI",
    status: "available",
    version: "1",
    configVersion: "1",
    configDigest: "digest-catalog",
    capabilities: [],
    requiredSecrets: [{ name: "apiKey", required: true, configured: false }],
    isDefault: false,
    metadata: {},
    ...overrides,
  };
}

function credential(overrides: Record<string, unknown> = {}) {
  return {
    id: "credential-1",
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    workspaceId: "workspace-1",
    providerInstanceId: "instance-1",
    scope: "workspace" as const,
    ownerUserId: null,
    providerId: "openai",
    credentialKind: "apiKey",
    keyVersion: 1,
    secretRevision: 1,
    status: "active" as const,
    ...overrides,
  };
}

function client(overrides: Record<string, unknown> = {}) {
  const target = provider({
    id: "instance-1",
    scope: "workspace",
    workspaceId: "workspace-1",
    configDigest: "digest-instance",
  });
  return {
    createProviderInstance: vi.fn().mockResolvedValue(target),
    listProviderCredentials: vi
      .fn()
      .mockResolvedValue({ items: [], page: { nextCursor: null, hasMore: false } }),
    createProviderCredential: vi.fn().mockImplementation(async (input) =>
      credential({
        id: "credential-created",
        providerInstanceId: input.providerInstanceId,
        scope: input.scope,
      }),
    ),
    updateProviderCredential: vi.fn().mockImplementation(async (id) => credential({ id })),
    updateProviderInstance: vi.fn().mockResolvedValue(target),
    ...overrides,
  };
}

describe("web provider setup", () => {
  it("creates a workspace instance for a system catalog entry", async () => {
    const api = client();
    await saveProviderSetup({
      api,
      provider: provider(),
      displayName: "My OpenAI",
      config: { endpoint: "https://api.example.com" },
      secrets: {},
    });

    expect(api.createProviderInstance).toHaveBeenCalledWith({
      providerId: "openai",
      module: "model",
      scope: "workspace",
      displayName: "My OpenAI",
      config: { endpoint: "https://api.example.com" },
      credentialBindings: [],
    });
    expect(api.updateProviderInstance).toHaveBeenCalledWith("instance-1", {
      displayName: "My OpenAI",
      config: { endpoint: "https://api.example.com" },
      credentialBindings: [],
      expectedConfigDigest: "digest-instance",
    });
  });

  it("creates an encrypted credential and binds it without putting the secret in config", async () => {
    const api = client();
    await saveProviderSetup({
      api,
      provider: provider(),
      config: { defaultModel: "gpt-4o-mini" },
      secrets: { apiKey: "sk-live" },
    });

    expect(api.createProviderCredential).toHaveBeenCalledWith({
      providerId: "openai",
      providerInstanceId: "instance-1",
      credentialKind: "apiKey",
      scope: "workspace",
      secret: "sk-live",
    });
    expect(api.updateProviderInstance).toHaveBeenCalledWith("instance-1", {
      config: { defaultModel: "gpt-4o-mini" },
      credentialBindings: [{ name: "apiKey", credentialId: "credential-created" }],
      expectedConfigDigest: "digest-instance",
    });
    expect(api.updateProviderInstance.mock.calls[0]?.[1]).not.toHaveProperty("apiKey");
  });

  it("rotates an active credential instead of creating a duplicate", async () => {
    const current = credential();
    const api = client({
      listProviderCredentials: vi.fn().mockResolvedValue({
        items: [current],
        page: { nextCursor: null, hasMore: false },
      }),
    });
    await saveProviderSetup({
      api,
      provider: provider({
        scope: "workspace",
        workspaceId: "workspace-1",
        id: "instance-1",
        configDigest: "digest-instance",
      }),
      config: {},
      secrets: { apiKey: "sk-rotated" },
    });

    expect(api.updateProviderCredential).toHaveBeenCalledWith("credential-1", {
      secret: "sk-rotated",
    });
    expect(api.createProviderCredential).not.toHaveBeenCalled();
  });

  it("uses user scope for user-owned instances", async () => {
    const api = client();
    await saveProviderSetup({
      api,
      provider: provider({ scope: "user", workspaceId: "workspace-1", id: "instance-1" }),
      config: {},
      secrets: { apiKey: "sk-user" },
    });

    expect(api.listProviderCredentials).toHaveBeenCalledWith({
      providerId: "openai",
      providerInstanceId: "instance-1",
      scope: "user",
      status: "active",
      limit: 100,
    });
    expect(api.createProviderCredential).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "user", secret: "sk-user" }),
    );
  });

  it("retains an active binding when its secret field is left blank", async () => {
    const current = credential();
    const api = client({
      listProviderCredentials: vi.fn().mockResolvedValue({
        items: [current],
        page: { nextCursor: null, hasMore: false },
      }),
    });
    await saveProviderSetup({
      api,
      provider: provider({
        scope: "workspace",
        workspaceId: "workspace-1",
        id: "instance-1",
        configDigest: "digest-instance",
      }),
      config: {},
      secrets: { apiKey: "   " },
    });

    expect(api.updateProviderCredential).not.toHaveBeenCalled();
    expect(api.updateProviderInstance).toHaveBeenCalledWith("instance-1", {
      config: {},
      credentialBindings: [{ name: "apiKey", credentialId: "credential-1" }],
      expectedConfigDigest: "digest-instance",
    });
  });

  it("omits a missing binding so the server can keep the setup pending", async () => {
    const api = client();
    await saveProviderSetup({
      api,
      provider: provider({
        scope: "workspace",
        workspaceId: "workspace-1",
        id: "instance-1",
        configDigest: "digest-instance",
      }),
      config: {},
      secrets: {},
    });

    expect(api.updateProviderInstance).toHaveBeenCalledWith("instance-1", {
      config: {},
      credentialBindings: [],
      expectedConfigDigest: "digest-instance",
    });
  });

  it("does not retry the CAS PATCH after a conflict", async () => {
    const api = client({
      updateProviderInstance: vi
        .fn()
        .mockRejectedValue(new Error("Provider configuration changed")),
    });
    await expect(
      saveProviderSetup({
        api,
        provider: provider({ scope: "workspace", workspaceId: "workspace-1", id: "instance-1" }),
        config: {},
        secrets: { apiKey: "sk-once" },
      }),
    ).rejects.toThrow("Provider configuration changed");
    expect(api.updateProviderInstance).toHaveBeenCalledTimes(1);
  });
});
