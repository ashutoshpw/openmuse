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

function client(overrides: Record<string, unknown> = {}) {
  const target = provider({
    id: "instance-1",
    scope: "workspace",
    workspaceId: "workspace-1",
    configDigest: "digest-instance",
  });
  return {
    createProviderInstance: jest.fn().mockResolvedValue(target),
    setupProviderInstance: jest.fn().mockResolvedValue(target),
    ...overrides,
  };
}

describe("mobile provider setup", () => {
  it("creates a workspace instance and submits one atomic setup", async () => {
    const api = client();
    await saveProviderSetup({
      api,
      provider: provider(),
      displayName: "My OpenAI",
      config: { endpoint: "https://api.example.com" },
      secrets: { apiKey: "sk-mobile" },
    });

    expect(api.createProviderInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        module: "model",
        scope: "workspace",
        credentialBindings: [],
      }),
    );
    expect(api.setupProviderInstance).toHaveBeenCalledWith("instance-1", {
      expectedConfigDigest: "digest-instance",
      displayName: "My OpenAI",
      config: { endpoint: "https://api.example.com" },
      secrets: { apiKey: "sk-mobile" },
    });
  });

  it("uses one atomic setup for an existing instance and never calls credential APIs", async () => {
    const api = client();
    await saveProviderSetup({
      api,
      provider: provider({
        scope: "workspace",
        workspaceId: "workspace-1",
        id: "instance-1",
        configDigest: "digest-instance",
      }),
      config: { defaultModel: "gpt" },
      secrets: { apiKey: "sk-rotated" },
    });

    expect(api.createProviderInstance).not.toHaveBeenCalled();
    expect(api.setupProviderInstance).toHaveBeenCalledTimes(1);
    expect(api.setupProviderInstance).toHaveBeenCalledWith("instance-1", {
      expectedConfigDigest: "digest-instance",
      config: { defaultModel: "gpt" },
      secrets: { apiKey: "sk-rotated" },
    });
  });

  it("omits blank secrets so the server preserves existing credentials", async () => {
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
      secrets: { apiKey: "   " },
    });

    expect(api.setupProviderInstance).toHaveBeenCalledWith("instance-1", {
      expectedConfigDigest: "digest-instance",
      config: {},
    });
  });

  it("propagates a stale-digest conflict without retrying or resubmitting the secret", async () => {
    const conflict = new Error("Provider configuration changed");
    const api = client({ setupProviderInstance: jest.fn().mockRejectedValue(conflict) });

    await expect(
      saveProviderSetup({
        api,
        provider: provider({ scope: "workspace", workspaceId: "workspace-1", id: "instance-1" }),
        config: {},
        secrets: { apiKey: "sk-once" },
      }),
    ).rejects.toBe(conflict);
    expect(api.setupProviderInstance).toHaveBeenCalledTimes(1);
  });

  it("returns provider metadata without returning the submitted secret", async () => {
    const config = { defaultModel: "gpt" };
    const result = provider({
      scope: "workspace",
      workspaceId: "workspace-1",
      id: "instance-1",
    });
    const api = client({ setupProviderInstance: jest.fn().mockResolvedValue(result) });

    const saved = await saveProviderSetup({
      api,
      provider: result,
      config,
      secrets: { apiKey: "sk-never-returned" },
    });

    expect(saved).toEqual(result);
    expect(saved).not.toHaveProperty("secrets");
    expect(JSON.stringify(saved)).not.toContain("sk-never-returned");
  });
});
