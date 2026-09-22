import { randomBytes, randomUUID } from "node:crypto";
import { createOpenMuseAuth } from "@openmuse/auth";
import { createBuiltinProviderCatalog, decryptCredentialEnvelope } from "@openmuse/provider-server";
import { createOpenAiCompatibleModelDriver } from "../../../packages/providers/model-openai-compatible/src/index.js";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createApi } from "../src/app.js";
import {
  provisionIntegrationDatabase,
  type OpenMuseIntegrationHarness,
} from "./support/postgres.js";

const integration = Boolean(process.env.TEST_DATABASE_URL);
const origin = "http://localhost:5173";
const authSecret = "openmuse-chat-review-secret-2026-contains-32-bytes";
const encryptionKey = randomBytes(32).toString("base64url");

type Envelope<T = unknown> = {
  data?: T;
  error?: { code?: string; message?: string };
};

type ProviderInstanceResource = {
  id: string;
  configDigest: string;
  config?: Record<string, unknown>;
};

type ProviderCredentialResource = {
  id: string;
  providerInstanceId: string;
  secretRevision: number;
};

type RunResource = {
  id: string;
  providerInstanceId: string | null;
  configDigest: string | null;
};

describe.skipIf(!integration)("OpenMuse chat/provider adversarial PostgreSQL integration", () => {
  let harness: OpenMuseIntegrationHarness;
  let api: ReturnType<typeof createApi>;
  let auth: ReturnType<typeof createOpenMuseAuth>;
  let actorAToken = "";
  let actorBToken = "";
  let sharedInstance: ProviderInstanceResource;

  beforeAll(async () => {
    harness = await provisionIntegrationDatabase();
    auth = createOpenMuseAuth(harness.auth, {
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
      providerCatalog: createBuiltinProviderCatalog({
        trustedEndpoints: ["http://127.0.0.1:11434"],
      }),
      credentialEncryptionKey: encryptionKey,
    });
    currentApi = api;
    actorAToken = await signIn(api, harness.ids.userA);
    actorBToken = await signIn(api, harness.ids.userB);
    sharedInstance = await createProviderInstance(actorAToken, {
      providerId: "ollama",
      module: "model",
      scope: "workspace",
      displayName: "Review shared Ollama",
      config: { endpoint: "http://127.0.0.1:11434", defaultModel: "review" },
    });
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it("keeps private chat descendants and shared-provider mutations actor-scoped", async () => {
    const clientMessageId = randomUUID();
    const submission = await requestJson<Envelope<{ run: RunResource }>>(
      "/api/v1/conversations/" + harness.ids.conversation + "/messages",
      actorAToken,
      {
        method: "POST",
        body: {
          conversationId: harness.ids.conversation,
          clientMessageId,
          providerInstanceId: sharedInstance.id,
          parts: [{ type: "text", text: "owner-only review message" }],
        },
      },
    );
    if (submission.response.status !== 200) {
      const [orphans] = await harness.owner.sql<
        { messages: string; runs: string; events: string; tasks: string }[]
      >`
        select
          (select count(*)::text from messages where id = ${clientMessageId}) as messages,
          (select count(*)::text from runs where idempotency_key = ${clientMessageId}) as runs,
          (
            select count(*)::text
            from run_events
            where run_id in (select id from runs where idempotency_key = ${clientMessageId})
          ) as events,
          (
            select count(*)::text
            from tasks
            where run_id in (select id from runs where idempotency_key = ${clientMessageId})
          ) as tasks
      `;
      expect(orphans).toEqual({ messages: "0", runs: "0", events: "0", tasks: "0" });
    }
    expect(submission.response.status, JSON.stringify(submission.body)).toBe(200);
    const runId = submission.body.data?.run.id;
    expect(runId).toEqual(expect.any(String));

    const forbiddenRequests = await Promise.all([
      requestJson<Envelope>(`/api/v1/conversations/${harness.ids.conversation}`, actorBToken),
      requestJson<Envelope>(
        `/api/v1/conversations/${harness.ids.conversation}/messages`,
        actorBToken,
      ),
      requestJson<Envelope>(`/api/v1/runs/${runId}`, actorBToken),
      requestJson<Envelope>(`/api/v1/runs/${runId}/events`, actorBToken),
      requestJson<Envelope>(`/api/v1/runs/${runId}/cancel`, actorBToken, {
        method: "POST",
        body: { reason: "cross-actor cancellation" },
      }),
      requestJson<Envelope>(`/api/v1/provider-instances/${sharedInstance.id}`, actorBToken, {
        method: "PATCH",
        body: { displayName: "attacker mutation" },
      }),
    ]);

    expect(forbiddenRequests.slice(0, 5).map(({ response }) => response.status)).toEqual([
      404, 404, 404, 404, 404,
    ]);
    expect(forbiddenRequests[5]?.response.status).toBe(403);
  });

  it("rejects untrusted, credential-bearing, and prefix-confusable provider endpoints", async () => {
    const cases = [
      "https://attacker.example/v1",
      "https://api.openai.com.evil.example/v1",
      "https://api.openai.com/v10",
      "https://user:password@api.openai.com/v1",
      "http://127.0.0.1:11434.evil.example",
    ];
    const responses = await Promise.all(
      cases.map((endpoint) =>
        requestJson<Envelope>("/api/v1/provider-instances", actorAToken, {
          method: "POST",
          body: {
            providerId: "openai-compatible",
            module: "model",
            scope: "user",
            config: { endpoint },
          },
        }),
      ),
    );
    expect(responses.map(({ response }) => response.status)).toEqual(cases.map(() => 400));
    expect(responses.every(({ body }) => body.error?.code === "invalid_request")).toBe(true);
    expect(responses.some(({ body }) => JSON.stringify(body).includes("password"))).toBe(false);

    // This records the current explicit built-in trust boundary. A deployment
    // that hosts the API away from Ollama must decide whether this loopback
    // default should remain trusted instead of treating it as proof of safety.
    const ollama = await requestJson<Envelope<ProviderInstanceResource>>(
      "/api/v1/provider-instances",
      actorAToken,
      {
        method: "POST",
        body: {
          providerId: "ollama",
          module: "model",
          scope: "user",
          config: { endpoint: "http://127.0.0.1:11434" },
        },
      },
    );
    expect(ollama.response.status).toBe(200);
    expect(ollama.body.data?.id).toEqual(expect.any(String));
  });

  it("does not let a demoted creator mutate a shared instance while preserving personal BYOK ownership", async () => {
    await harness.owner.sql`
      update workspace_members
      set role = 'member'
      where workspace_id = ${harness.ids.workspace} and user_id = ${harness.ids.userA}
    `;
    try {
      const demotedMutation = await requestJson<Envelope>(
        `/api/v1/provider-instances/${sharedInstance.id}`,
        actorAToken,
        { method: "PATCH", body: { displayName: "demoted creator mutation" } },
      );
      expect(demotedMutation.response.status, JSON.stringify(demotedMutation.body)).toBe(403);
    } finally {
      await harness.owner.sql`
        update workspace_members
        set role = 'owner'
        where workspace_id = ${harness.ids.workspace} and user_id = ${harness.ids.userA}
      `;
    }

    const personal = await createProviderInstance(actorAToken, {
      providerId: "openai-compatible",
      module: "model",
      scope: "user",
      displayName: "Personal BYOK review",
      config: {},
    });
    const credential = await requestJson<Envelope<ProviderCredentialResource>>(
      "/api/v1/provider-credentials",
      actorAToken,
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          providerInstanceId: personal.id,
          credentialKind: "apiKeySecret",
          scope: "user",
          secret: "personal-byok-secret",
        },
      },
    );
    expect(credential.response.status).toBe(200);
    expect(credential.body.data?.secretRevision).toBe(1);
  });

  it("rotates a credential with compare-and-swap and never returns its secret", async () => {
    const personal = await createProviderInstance(actorAToken, {
      providerId: "openai-compatible",
      module: "model",
      scope: "user",
      displayName: "Rotation review",
      config: {},
    });
    const created = await requestJson<Envelope<ProviderCredentialResource>>(
      "/api/v1/provider-credentials",
      actorAToken,
      {
        method: "POST",
        body: {
          providerId: "openai-compatible",
          providerInstanceId: personal.id,
          credentialKind: "apiKeySecret",
          scope: "user",
          secret: "rotation-initial-secret",
        },
      },
    );
    expect(created.response.status).toBe(200);
    const credentialId = created.body.data?.id;
    expect(credentialId).toEqual(expect.any(String));
    expect(JSON.stringify(created.body)).not.toContain("rotation-initial-secret");

    const read = await requestJson<Envelope<ProviderCredentialResource>>(
      `/api/v1/provider-credentials/${credentialId}`,
      actorAToken,
    );
    expect(read.response.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain("rotation-initial-secret");
    expect(read.body.data?.secretRevision).toBe(1);

    const rotations = await Promise.all(
      ["rotation-a-secret", "rotation-b-secret"].map((secret) =>
        requestJson<Envelope<ProviderCredentialResource>>(
          `/api/v1/provider-credentials/${credentialId}`,
          actorAToken,
          { method: "PATCH", body: { secret } },
        ),
      ),
    );
    expect(rotations.filter(({ response }) => response.status === 200)).toHaveLength(1);
    expect(rotations.filter(({ response }) => response.status === 409)).toHaveLength(1);
    expect(rotations.every(({ body }) => !JSON.stringify(body).includes("rotation-"))).toBe(true);

    const after = await requestJson<Envelope<ProviderCredentialResource>>(
      `/api/v1/provider-credentials/${credentialId}`,
      actorAToken,
    );
    expect(after.response.status).toBe(200);
    expect(after.body.data?.secretRevision).toBe(2);

    const [stored] = await harness.owner.sql<
      {
        encrypted_value: string;
        key_version: number;
        secret_revision: number;
        created_by: string;
      }[]
    >`
      select encrypted_value, key_version, secret_revision, created_by
      from provider_credentials
      where id = ${credentialId}
    `;
    expect(stored?.encrypted_value).toBeTruthy();
    expect(stored?.encrypted_value).not.toContain("rotation-");
    expect(stored?.key_version).toBe(1);
    expect(stored?.secret_revision).toBe(2);
    expect(stored?.created_by).toBe(harness.ids.userA);
    const decrypted = decryptCredentialEnvelope(stored!.encrypted_value, encryptionKey, {
      workspaceId: harness.ids.workspace,
      actorId: harness.ids.userA,
      providerInstanceId: personal.id,
      secretName: "apiKeySecret",
      revision: 2,
    });
    expect(["rotation-a-secret", "rotation-b-secret"]).toContain(decrypted);
  });

  it("keeps the run provider snapshot pinned and makes same-key conflicting content fail closed", async () => {
    const conversation = await createConversation(
      actorAToken,
      "Pinning review",
      harness.ids.workspace,
    );
    const clientMessageId = randomUUID();
    const first = await requestJson<Envelope<{ run: RunResource }>>(
      `/api/v1/conversations/${conversation}/messages`,
      actorAToken,
      {
        method: "POST",
        body: {
          conversationId: conversation,
          clientMessageId,
          providerInstanceId: sharedInstance.id,
          parts: [{ type: "text", text: "pinned content" }],
        },
      },
    );
    expect(first.response.status).toBe(200);
    const firstRun = first.body.data?.run;
    expect(firstRun?.providerInstanceId).toBe(sharedInstance.id);
    expect(firstRun?.configDigest).toEqual(expect.any(String));

    const [storedBefore] = await harness.owner.sql<
      { provider_config: Record<string, unknown>; config_digest: string }[]
    >`
      select provider_config, config_digest
      from runs
      where id = ${firstRun?.id}
    `;
    expect(storedBefore?.provider_config).toMatchObject({ endpoint: "http://127.0.0.1:11434" });
    expect(storedBefore?.config_digest).toBe(firstRun?.configDigest);

    const changed = await requestJson<Envelope<ProviderInstanceResource>>(
      `/api/v1/provider-instances/${sharedInstance.id}`,
      actorAToken,
      {
        method: "PATCH",
        body: {
          config: { endpoint: "http://127.0.0.1:11434/changed", defaultModel: "changed" },
          expectedConfigDigest: sharedInstance.configDigest,
        },
      },
    );
    expect(changed.response.status).toBe(200);
    expect(changed.body.data?.configDigest).not.toBe(sharedInstance.configDigest);

    const [storedAfter] = await harness.owner.sql<
      { provider_config: Record<string, unknown>; config_digest: string }[]
    >`
      select provider_config, config_digest
      from runs
      where id = ${firstRun?.id}
    `;
    expect(storedAfter?.provider_config).toMatchObject({
      endpoint: "http://127.0.0.1:11434",
      defaultModel: "review",
    });
    expect(storedAfter?.config_digest).toBe(firstRun?.configDigest);

    const concurrentConversation = await createConversation(
      actorAToken,
      "Idempotency review",
      harness.ids.workspace,
    );
    const sameKey = randomUUID();
    const [same, sameDuplicate] = await Promise.all([
      sendMessage(actorAToken, concurrentConversation, sameKey, sharedInstance.id, "same body"),
      sendMessage(actorAToken, concurrentConversation, sameKey, sharedInstance.id, "same body"),
    ]);
    expect(same.response.status).toBe(200);
    expect(sameDuplicate.response.status).toBe(200);
    expect(same.body.data?.run.id).toBe(sameDuplicate.body.data?.run.id);

    const conflict = await sendMessage(
      actorAToken,
      concurrentConversation,
      sameKey,
      sharedInstance.id,
      "different body",
    );
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error?.code).toBe("conflict");

    const rows = await harness.owner.sql<{ messages: string; runs: string; tasks: string }[]>`
      select
        (select count(*)::text from messages where id = ${sameKey}) as messages,
        (select count(*)::text from runs where conversation_id = ${concurrentConversation}) as runs,
        (select count(*)::text from tasks where run_id in (select id from runs where conversation_id = ${concurrentConversation})) as tasks
    `;
    expect(rows[0]).toEqual({ messages: "1", runs: "1", tasks: "1" });
  });

  it("rejects redirects in provider HTTP requests before an endpoint can receive credentials", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const driver = createOpenAiCompatibleModelDriver({
      defaultEndpoint: "https://trusted.example/v1",
      fetch: async (input, init) => {
        calls.push({ input, init });
        if (String(input).endsWith("/chat/completions"))
          return Response.redirect("https://attacker.example/steal", 302);
        return new Response("", { status: 404 });
      },
    });
    const client = await driver.create(
      driver.config.schema.parse({ apiKeySecret: "credential-ref" }),
      {
        scopeId: "review",
        signal: new AbortController().signal,
        secrets: { resolve: async () => "review-secret" },
      },
    );
    const result = (async () => {
      const events = [];
      for await (const event of client.generate(
        { messages: [{ role: "user", parts: [{ type: "text", text: "redirect" }] }] },
        { signal: new AbortController().signal, operationId: "redirect-review" },
      )) {
        events.push(event);
      }
      return events;
    })();
    await expect(result).rejects.toMatchObject({
      code: expect.any(String),
      providerId: "openai-compatible",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe("error");
    await client.close?.("redirect review complete");
  });
});

async function signIn(api: ReturnType<typeof createApi>, userId: string): Promise<string> {
  const response = await api.request(
    request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({
        email: `${userId === "" ? "" : userId.startsWith("user-a") ? "a-" : "b-"}${userId}@example.test`,
        password: "openmuse-integration-password-2026",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`Could not sign in ${userId}: ${response.status}`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string")
    throw new Error(`Sign-in did not return a token for ${userId}`);
  return body.token;
}

async function createProviderInstance(
  token: string,
  input: {
    providerId: string;
    module: "model";
    scope: "workspace" | "user";
    displayName: string;
    config: Record<string, unknown>;
  },
): Promise<ProviderInstanceResource> {
  const result = await requestJson<Envelope<ProviderInstanceResource>>(
    "/api/v1/provider-instances",
    token,
    { method: "POST", body: input },
  );
  if (result.response.status !== 200 || !result.body.data)
    throw new Error(`Provider instance creation failed: ${result.response.status}`);
  return result.body.data;
}

async function createConversation(
  token: string,
  title: string,
  workspaceId: string,
): Promise<string> {
  const result = await requestJson<Envelope<{ id: string }>>("/api/v1/conversations", token, {
    method: "POST",
    body: { workspaceId, title },
  });
  if (result.response.status !== 200 || !result.body.data?.id)
    throw new Error(
      `Conversation creation failed: ${result.response.status} ${JSON.stringify(result.body)}`,
    );
  return result.body.data.id;
}

async function sendMessage(
  token: string,
  conversationId: string,
  clientMessageId: string,
  providerInstanceId: string,
  text: string,
): Promise<{ response: Response; body: Envelope<{ run: RunResource }> }> {
  return requestJson<Envelope<{ run: RunResource }>>(
    `/api/v1/conversations/${conversationId}/messages`,
    token,
    {
      method: "POST",
      body: {
        conversationId,
        clientMessageId,
        providerInstanceId,
        parts: [{ type: "text", text }],
      },
    },
  );
}

async function requestJson<T>(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ response: Response; body: T }> {
  const response = await currentApi!.request(
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

let currentApi: ReturnType<typeof createApi> | undefined;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost:8787${path}`, init);
}
