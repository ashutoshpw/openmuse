import { randomBytes } from "node:crypto";
import { createOpenMuseAuth } from "@openmuse/auth";
import { createBuiltinProviderCatalog } from "@openmuse/provider-server";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createApi } from "../src/app.js";
import {
  provisionIntegrationDatabase,
  type OpenMuseIntegrationHarness,
} from "./support/postgres.js";

const integration = Boolean(process.env.TEST_DATABASE_URL);
const origin = "http://localhost:5173";
const authSecret = "openmuse-provider-safety-secret-2026-contains-32-bytes";
const encryptionKey = randomBytes(32).toString("base64url");

type Envelope<T = unknown> = {
  data?: T;
  error?: { code?: string; message?: string };
};

type ProviderInstance = {
  id: string;
  configDigest: string;
};

type ProviderInstanceResource = ProviderInstance & {
  status: string;
  scope: string;
  displayName: string;
  ownerUserId: string | null;
  isDefault: boolean;
};

type ProviderCredential = {
  id: string;
};

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost:8787${path}`, init);
}

function requireInstance(body: Envelope<ProviderInstanceResource>): ProviderInstanceResource {
  const instance = body.data;
  if (
    !instance ||
    typeof instance.id !== "string" ||
    typeof instance.configDigest !== "string" ||
    typeof instance.status !== "string" ||
    typeof instance.scope !== "string" ||
    typeof instance.displayName !== "string" ||
    (instance.ownerUserId !== null && typeof instance.ownerUserId !== "string") ||
    typeof instance.isDefault !== "boolean"
  )
    throw new Error(`Expected provider instance resource, got ${JSON.stringify(body)}`);
  return instance;
}

function requireCredential(body: Envelope<ProviderCredential>): ProviderCredential {
  const credential = body.data;
  if (!credential || typeof credential.id !== "string")
    throw new Error(`Expected provider credential resource, got ${JSON.stringify(body)}`);
  return credential;
}

describe.skipIf(!integration)("OpenMuse provider safety PostgreSQL integration", () => {
  let harness: OpenMuseIntegrationHarness;
  let api: ReturnType<typeof createApi>;
  let bearerToken = "";
  let bearerTokenB = "";

  beforeAll(async () => {
    harness = await provisionIntegrationDatabase();
    const auth = createOpenMuseAuth(harness.auth, {
      secret: authSecret,
      baseURL: "http://localhost:8787",
      trustedOrigins: [origin],
      secureCookies: false,
      environment: "test",
    });
    api = createApi({
      db: harness.runtime,
      auth,
      allowedOrigins: [origin],
      providerCatalog: createBuiltinProviderCatalog(),
      credentialEncryptionKey: encryptionKey,
    });
    bearerToken = await signIn(`a-${harness.ids.userA}@example.test`);
    bearerTokenB = await signIn(`b-${harness.ids.userB}@example.test`);
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it("returns a conflict when revoke wins after default preflight", async () => {
    const instanceResponse = await requestJson<Envelope<ProviderInstance>>(
      "/api/v1/provider-instances",
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          module: "model",
          scope: "user",
          displayName: "Deterministic provider safety race",
          config: {},
        },
      },
    );
    expect(instanceResponse.response.status).toBe(200);
    const instance = instanceResponse.body.data;
    expect(typeof instance?.id).toBe("string");
    expect(typeof instance?.configDigest).toBe("string");

    const credentialResponse = await requestJson<Envelope<ProviderCredential>>(
      "/api/v1/provider-credentials",
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          providerInstanceId: instance!.id,
          credentialKind: "apiKeySecret",
          scope: "user",
          secret: "provider-safety-race-secret",
        },
      },
    );
    expect(credentialResponse.response.status, JSON.stringify(credentialResponse.body)).toBe(200);
    const credentialId = credentialResponse.body.data?.id;
    expect(credentialId).toEqual(expect.any(String));

    const configured = await requestJson<Envelope<ProviderInstance>>(
      `/api/v1/provider-instances/${instance!.id}`,
      {
        method: "PATCH",
        body: {
          credentialBindings: [{ name: "apiKeySecret", credentialId }],
          expectedConfigDigest: instance!.configDigest,
        },
      },
    );
    expect(configured.response.status).toBe(200);

    let releaseLock!: () => void;
    let signalLockAcquired!: () => void;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockAcquired = new Promise<void>((resolve) => {
      signalLockAcquired = resolve;
    });
    const lockTransaction = harness.owner.sql.begin(async (tx) => {
      await tx`
        select id
        from provider_instances
        where id = ${instance!.id}
        for update
      `;
      signalLockAcquired();
      await lockReleased;
    });
    await lockAcquired;

    let revoke: Promise<Response> | undefined;
    try {
      // Revoke first so PostgreSQL queues its instance lock ahead of default
      // selection. Both requests still complete their preflight reads while
      // the owner transaction holds the row lock.
      revoke = requestRaw(`/api/v1/provider-credentials/${credentialId}`, {
        method: "DELETE",
      });
      await waitForProviderInstanceLockWaiters(1);

      const makeDefault = requestJson<Envelope<ProviderInstance>>(
        `/api/v1/provider-instances/${instance!.id}`,
        { method: "PATCH", body: { isDefault: true } },
      );
      await waitForProviderInstanceLockWaiters(2);
      releaseLock();

      const [defaultResult, revokeResult] = await Promise.all([makeDefault, revoke]);
      expect(revokeResult.status).toBe(204);
      expect(defaultResult.response.status).toBe(409);
      expect(defaultResult.body.error?.code).toBe("conflict");
    } finally {
      releaseLock();
      await lockTransaction;
    }

    const [staleDefault] = await harness.owner.sql<{ count: string }[]>`
      select count(*)::text as count
      from provider_instance_defaults d
      inner join provider_credentials c on c.provider_instance_id = d.provider_instance_id
      where d.provider_instance_id = ${instance!.id}
        and c.id = ${credentialId}
        and c.status = 'revoked'
    `;
    expect(staleDefault?.count).toBe("0");
  });

  it("rejects a stale setup digest before credential revision writes", async () => {
    const created = await requestJson<Envelope<ProviderInstanceResource>>(
      "/api/v1/provider-instances",
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          module: "model",
          scope: "user",
          displayName: "Stale setup digest fixture",
          config: {},
        },
      },
    );
    expect(created.response.status).toBe(200);
    const instance = requireInstance(created.body);

    const configured = await requestJson<Envelope<ProviderInstanceResource>>(
      `/api/v1/provider-instances/${instance.id}/setup`,
      {
        method: "POST",
        body: {
          expectedConfigDigest: instance.configDigest,
          secrets: { apiKeySecret: "stale-digest-initial-secret" },
        },
      },
    );
    expect(configured.response.status).toBe(200);
    const configuredInstance = requireInstance(configured.body);
    expect(configuredInstance.configDigest).not.toBe(instance.configDigest);

    const [before] = await harness.owner.sql<
      { id: string; secretRevision: number; encryptedValue: string }[]
    >`
      select
        id,
        secret_revision as "secretRevision",
        encrypted_value as "encryptedValue"
      from provider_credentials
      where provider_instance_id = ${instance.id}
    `;
    if (!before) throw new Error("Expected the initial provider credential to be persisted");

    const stale = await requestJson<Envelope>(`/api/v1/provider-instances/${instance.id}/setup`, {
      method: "POST",
      body: {
        expectedConfigDigest: instance.configDigest,
        secrets: { apiKeySecret: "stale-digest-should-not-persist" },
      },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body.error?.code).toBe("conflict");

    const [after] = await harness.owner.sql<
      { id: string; secretRevision: number; encryptedValue: string }[]
    >`
      select
        id,
        secret_revision as "secretRevision",
        encrypted_value as "encryptedValue"
      from provider_credentials
      where provider_instance_id = ${instance.id}
    `;
    expect(after).toEqual(before);
    expect(configuredInstance.configDigest).not.toBe(instance.configDigest);
  });

  it("allows one winner for concurrent setup requests with the same digest", async () => {
    const created = await requestJson<Envelope<ProviderInstanceResource>>(
      "/api/v1/provider-instances",
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          module: "model",
          scope: "user",
          displayName: "Concurrent setup winner fixture",
          config: {},
        },
      },
    );
    expect(created.response.status).toBe(200);
    const instance = requireInstance(created.body);

    const [first, second] = await Promise.all([
      requestJson<Envelope<ProviderInstanceResource>>(
        `/api/v1/provider-instances/${instance.id}/setup`,
        {
          method: "POST",
          body: {
            expectedConfigDigest: instance.configDigest,
            secrets: { apiKeySecret: "concurrent-setup-secret-one" },
          },
        },
      ),
      requestJson<Envelope<ProviderInstanceResource>>(
        `/api/v1/provider-instances/${instance.id}/setup`,
        {
          method: "POST",
          body: {
            expectedConfigDigest: instance.configDigest,
            secrets: { apiKeySecret: "concurrent-setup-secret-two" },
          },
        },
      ),
    ]);

    expect([first.response.status, second.response.status].toSorted((a, b) => a - b)).toEqual([
      200, 409,
    ]);
    const winner = first.response.status === 200 ? first : second;
    const loser = first.response.status === 200 ? second : first;
    requireInstance(winner.body);
    expect(loser.body.error?.code).toBe("conflict");

    const credentials = await harness.owner.sql<
      { id: string; secretRevision: number; status: string }[]
    >`
      select
        id,
        secret_revision as "secretRevision",
        status
      from provider_credentials
      where provider_instance_id = ${instance.id}
    `;
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.secretRevision).toBe(1);
    expect(credentials[0]?.status).toBe("active");
  });

  it("rolls back every credential in an invalid multi-secret setup", async () => {
    const created = await requestJson<Envelope<ProviderInstanceResource>>(
      "/api/v1/provider-instances",
      {
        method: "POST",
        body: {
          providerId: "s3",
          module: "storage",
          scope: "user",
          displayName: "Multi-secret rollback fixture",
          config: { bucket: "provider-safety-rollback-bucket" },
        },
      },
    );
    expect(created.response.status).toBe(200);
    const instance = requireInstance(created.body);

    const [before] = await harness.owner.sql<
      { configDigest: string; credentialBindings: unknown }[]
    >`
      select
        config_digest as "configDigest",
        credential_bindings as "credentialBindings"
      from provider_instances
      where id = ${instance.id}
    `;
    if (!before) throw new Error("Expected the multi-secret provider instance to be persisted");

    const invalid = await requestJson<Envelope>(`/api/v1/provider-instances/${instance.id}/setup`, {
      method: "POST",
      body: {
        expectedConfigDigest: instance.configDigest,
        config: { bucket: "" },
        secrets: {
          accessKeyIdSecret: "multi-secret-access-value",
          secretAccessKeySecret: "multi-secret-secret-value",
        },
      },
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error?.code).toBe("invalid_request");
    expect(JSON.stringify(invalid.body)).not.toContain("multi-secret-access-value");
    expect(JSON.stringify(invalid.body)).not.toContain("multi-secret-secret-value");

    const [after] = await harness.owner.sql<
      { configDigest: string; credentialBindings: unknown }[]
    >`
      select
        config_digest as "configDigest",
        credential_bindings as "credentialBindings"
      from provider_instances
      where id = ${instance.id}
    `;
    expect(after).toEqual(before);
    const credentials = await harness.owner.sql<{ count: string }[]>`
      select count(*)::text as count
      from provider_credentials
      where provider_instance_id = ${instance.id}
    `;
    expect(credentials[0]?.count).toBe("0");
  });

  it("keeps personal scope separate from workspace administrator scope", async () => {
    const personalAResponse = await requestJson<Envelope<ProviderInstanceResource>>(
      "/api/v1/provider-instances",
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          module: "model",
          scope: "user",
          displayName: "User A personal scope fixture",
          config: {},
        },
      },
    );
    expect(personalAResponse.response.status).toBe(200);
    const personalA = requireInstance(personalAResponse.body);
    expect(personalA.ownerUserId).toBe(harness.ids.userA);

    const memberCannotReadPersonal = await requestJsonAs<Envelope>(
      bearerTokenB,
      `/api/v1/provider-instances/${personalA.id}`,
    );
    expect(memberCannotReadPersonal.response.status).toBe(404);

    const memberCannotCreateWorkspace = await requestJsonAs<Envelope>(
      bearerTokenB,
      "/api/v1/provider-instances",
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          module: "model",
          scope: "workspace",
          displayName: "Member workspace scope denied",
          config: {},
        },
      },
    );
    expect(memberCannotCreateWorkspace.response.status).toBe(403);
    expect(memberCannotCreateWorkspace.body.error?.code).toBe("forbidden");

    await harness.owner.sql`
      update workspace_members
      set role = 'admin'
      where workspace_id = ${harness.ids.workspace}
        and user_id = ${harness.ids.userB}
    `;

    const adminWorkspaceResponse = await requestJsonAs<Envelope<ProviderInstanceResource>>(
      bearerTokenB,
      "/api/v1/provider-instances",
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          module: "model",
          scope: "workspace",
          displayName: "Workspace admin scope fixture",
          config: {},
        },
      },
    );
    expect(adminWorkspaceResponse.response.status).toBe(200);
    const adminWorkspace = requireInstance(adminWorkspaceResponse.body);
    expect(adminWorkspace.scope).toBe("workspace");
    expect(adminWorkspace.ownerUserId).toBeNull();

    const adminUpdateWorkspace = await requestJsonAs<Envelope<ProviderInstanceResource>>(
      bearerTokenB,
      `/api/v1/provider-instances/${adminWorkspace.id}`,
      { method: "PATCH", body: { displayName: "Workspace admin scope updated" } },
    );
    expect(adminUpdateWorkspace.response.status).toBe(200);
    expect(requireInstance(adminUpdateWorkspace.body).displayName).toBe(
      "Workspace admin scope updated",
    );

    const adminCannotMutatePersonal = await requestJsonAs<Envelope>(
      bearerTokenB,
      `/api/v1/provider-instances/${personalA.id}`,
      { method: "PATCH", body: { displayName: "Must remain User A owned" } },
    );
    expect(adminCannotMutatePersonal.response.status).toBe(404);

    const personalBResponse = await requestJsonAs<Envelope<ProviderInstanceResource>>(
      bearerTokenB,
      "/api/v1/provider-instances",
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          module: "model",
          scope: "user",
          displayName: "User B personal scope fixture",
          config: {},
        },
      },
    );
    expect(personalBResponse.response.status).toBe(200);
    const personalB = requireInstance(personalBResponse.body);
    expect(personalB.ownerUserId).toBe(harness.ids.userB);

    const ownerCannotReadPersonalB = await requestJson<Envelope>(
      `/api/v1/provider-instances/${personalB.id}`,
    );
    expect(ownerCannotReadPersonalB.response.status).toBe(404);
  });

  it("clears defaults when disabling an instance and rejects disabled selection", async () => {
    const created = await requestJson<Envelope<ProviderInstanceResource>>(
      "/api/v1/provider-instances",
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          module: "model",
          scope: "user",
          displayName: "Disabled default fixture",
          config: {},
        },
      },
    );
    expect(created.response.status).toBe(200);
    const instance = requireInstance(created.body);

    const setup = await requestJson<Envelope<ProviderInstanceResource>>(
      `/api/v1/provider-instances/${instance.id}/setup`,
      {
        method: "POST",
        body: {
          expectedConfigDigest: instance.configDigest,
          secrets: { apiKeySecret: "disabled-default-secret" },
        },
      },
    );
    expect(setup.response.status).toBe(200);
    const configured = requireInstance(setup.body);

    const selectedInitially = await requestJson<Envelope<ProviderInstanceResource>>(
      `/api/v1/provider-instances/${instance.id}`,
      { method: "PATCH", body: { isDefault: true } },
    );
    expect(selectedInitially.response.status).toBe(200);
    expect(requireInstance(selectedInitially.body).configDigest).toBe(configured.configDigest);

    const instanceWithDefault = requireInstance(selectedInitially.body);
    expect(instanceWithDefault.isDefault).toBe(true);

    const disabled = await requestJson<Envelope<ProviderInstanceResource>>(
      `/api/v1/provider-instances/${instanceWithDefault.id}`,
      { method: "PATCH", body: { enabled: false } },
    );
    expect(disabled.response.status).toBe(200);
    const disabledInstance = requireInstance(disabled.body);
    expect(disabledInstance.status).toBe("disabled");
    expect(disabledInstance.isDefault).toBe(false);

    const [defaultRows] = await harness.owner.sql<{ count: string }[]>`
      select count(*)::text as count
      from provider_instance_defaults
      where provider_instance_id = ${instanceWithDefault.id}
    `;
    expect(defaultRows?.count).toBe("0");

    const disabledSelection = await requestJson<Envelope>(
      `/api/v1/provider-instances/${instanceWithDefault.id}`,
      { method: "PATCH", body: { isDefault: true } },
    );
    expect(disabledSelection.response.status).toBe(409);
    expect(disabledSelection.body.error?.code).toBe("conflict");

    const enabled = await requestJson<Envelope<ProviderInstanceResource>>(
      `/api/v1/provider-instances/${instanceWithDefault.id}`,
      { method: "PATCH", body: { enabled: true } },
    );
    expect(enabled.response.status).toBe(200);
    const enabledInstance = requireInstance(enabled.body);
    expect(enabledInstance.status).toBe("available");
    expect(enabledInstance.isDefault).toBe(false);

    const selected = await requestJson<Envelope<ProviderInstanceResource>>(
      `/api/v1/provider-instances/${instanceWithDefault.id}`,
      { method: "PATCH", body: { isDefault: true } },
    );
    expect(selected.response.status).toBe(200);
    expect(requireInstance(selected.body).isDefault).toBe(true);
  });

  it("exposes provider metadata without secrets in resources or errors", async () => {
    const created = await requestJson<Envelope<ProviderInstanceResource>>(
      "/api/v1/provider-instances",
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          module: "model",
          scope: "user",
          displayName: "Provider redaction fixture",
          config: {},
        },
      },
    );
    expect(created.response.status).toBe(200);
    const instance = requireInstance(created.body);
    const secret = "provider-safety-redaction-secret";

    const setup = await requestJson<Envelope<ProviderInstanceResource>>(
      `/api/v1/provider-instances/${instance.id}/setup`,
      {
        method: "POST",
        body: {
          expectedConfigDigest: instance.configDigest,
          secrets: { apiKeySecret: secret },
        },
      },
    );
    expect(setup.response.status).toBe(200);
    const setupText = JSON.stringify(setup.body);
    expect(setupText).not.toContain(secret);
    expect(setupText).not.toMatch(/encrypted[_-]?value|ciphertext|credentialBindings/i);

    const [credential] = await harness.owner.sql<{ id: string }[]>`
      select id
      from provider_credentials
      where provider_instance_id = ${instance.id}
    `;
    if (!credential) throw new Error("Expected the redaction fixture credential to be persisted");

    const credentialResponse = await requestJson<Envelope<ProviderCredential>>(
      `/api/v1/provider-credentials/${credential.id}`,
    );
    expect(credentialResponse.response.status).toBe(200);
    expect(requireCredential(credentialResponse.body).id).toBe(credential.id);
    const credentialText = JSON.stringify(credentialResponse.body);
    expect(credentialText).not.toContain(secret);
    expect(credentialText).not.toMatch(/encrypted[_-]?value|ciphertext/i);

    const instanceResponse = await requestJson<Envelope<ProviderInstanceResource>>(
      `/api/v1/provider-instances/${instance.id}`,
    );
    expect(instanceResponse.response.status).toBe(200);
    const instanceText = JSON.stringify(instanceResponse.body);
    expect(instanceText).not.toContain(secret);
    expect(instanceText).not.toMatch(/encrypted[_-]?value|ciphertext|credentialBindings/i);

    const invalidSetup = await requestJson<Envelope>(
      `/api/v1/provider-instances/${instance.id}/setup`,
      {
        method: "POST",
        body: {
          expectedConfigDigest: requireInstance(setup.body).configDigest,
          secrets: { undeclaredSecret: "provider-safety-error-secret" },
        },
      },
    );
    expect(invalidSetup.response.status).toBe(400);
    expect(JSON.stringify(invalidSetup.body)).not.toContain("provider-safety-error-secret");
    expect(JSON.stringify(invalidSetup.body)).not.toMatch(/encrypted[_-]?value|ciphertext/i);
  });

  async function signIn(email: string): Promise<string> {
    const response = await api.request(
      request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ email, password: harness.password }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token?: string };
    expect(body.token).toEqual(expect.any(String));
    return body.token ?? "";
  }

  async function waitForProviderInstanceLockWaiters(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [row] = await harness.owner.sql<{ count: string }[]>`
        select count(*)::text as count
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
          and query ilike '%provider_instances%'
      `;
      if (Number(row?.count ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${expected} provider instance lock waiters`);
  }

  async function requestJson<T>(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ response: Response; body: T }> {
    return requestJsonAs(bearerToken, path, init);
  }

  async function requestJsonAs<T>(
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<{ response: Response; body: T }> {
    const response = await api.request(
      request(path, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: origin,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
    return { response, body: (await response.json()) as T };
  }

  async function requestRaw(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    return requestRawAs(bearerToken, path, init);
  }

  async function requestRawAs(
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    return api.request(
      request(path, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: origin,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  }
});
