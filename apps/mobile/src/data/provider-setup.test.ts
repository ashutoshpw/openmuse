import type { ProviderInstance } from "@openmuse/contracts";
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
    createProviderInstance: jest.fn().mockResolvedValue(target),
    listProviderCredentials: jest
      .fn()
      .mockResolvedValue({ items: [], page: { nextCursor: null, hasMore: false } }),
    createProviderCredential: jest.fn().mockImplementation(async (input: any) =>
      credential({
        id: "credential-created",
        providerInstanceId: input.providerInstanceId,
        scope: input.scope,
      }),
    ),
    updateProviderCredential: jest
      .fn()
      .mockImplementation(async (id: string) => credential({ id })),
    updateProviderInstance: jest.fn().mockResolvedValue(target),
    ...overrides,
  };
}

describe("mobile provider setup", () => {
  it("derives workspace scope from a system catalog provider", async () => {
    const api = client();
    await saveProviderSetup({ api, provider: provider(), config: {}, secrets: {} });

    expect(api.createProviderInstance).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "workspace", credentialBindings: [] }),
    );
  });

  it("creates a credential with the typed encrypted-secret payload", async () => {
    const api = client();
    await saveProviderSetup({
      api,
      provider: provider(),
      config: {},
      secrets: { apiKey: "sk-mobile" },
    });

    expect(api.createProviderCredential).toHaveBeenCalledWith({
      providerId: "openai",
      providerInstanceId: "instance-1",
      credentialKind: "apiKey",
      scope: "workspace",
      secret: "sk-mobile",
    });
    expect(api.updateProviderInstance.mock.calls[0]?.[1]).not.toHaveProperty("apiKey");
  });

  it("pins credential bindings with the provider config digest", async () => {
    const api = client();
    await saveProviderSetup({
      api,
      provider: provider(),
      config: { defaultModel: "gpt" },
      secrets: {},
    });

    expect(api.updateProviderInstance).toHaveBeenCalledWith("instance-1", {
      config: { defaultModel: "gpt" },
      credentialBindings: [],
      expectedConfigDigest: "digest-instance",
    });
  });

  it("rotates an existing credential through PATCH", async () => {
    const api = client({
      listProviderCredentials: jest.fn().mockResolvedValue({
        items: [credential()],
        page: { nextCursor: null, hasMore: false },
      }),
    });
    await saveProviderSetup({
      api,
      provider: provider({ scope: "workspace", workspaceId: "workspace-1", id: "instance-1" }),
      config: {},
      secrets: { apiKey: "sk-rotated" },
    });

    expect(api.updateProviderCredential).toHaveBeenCalledWith("credential-1", {
      secret: "sk-rotated",
    });
    expect(api.createProviderCredential).not.toHaveBeenCalled();
  });

  it("does not retry after a compare-and-swap conflict", async () => {
    const api = client({
      updateProviderInstance: jest
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
