import { createOpenMuseAuth } from "@openmuse/auth";
import { createApiClient, type OpenMuseClient } from "../../../packages/client/src/index.js";
import { ConversationTaskHandler } from "../../../packages/application/src/index.js";
import {
  createBuiltinProviderRegistry,
  ProviderCatalog,
} from "../../../packages/provider-server/src/index.js";
import { DurableWorker } from "../../worker/src/runner.js";
import { WorkerProviderRuntime } from "../../worker/src/providers.js";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createApi } from "../src/app.js";
import {
  provisionIntegrationDatabase,
  type OpenMuseIntegrationHarness,
} from "./support/postgres.js";

const integration = Boolean(process.env.TEST_DATABASE_URL);
const origin = "http://localhost:5173";
const authSecret = "openmuse-chat-integration-secret-2026-contains-32-bytes";
const credentialSecret = "chat-integration-secret-never-returned";
const encryptionKey = Buffer.alloc(32, 7).toString("base64url");

describe.skipIf(!integration)("OpenMuse bounded chat PostgreSQL integration", () => {
  let harness: OpenMuseIntegrationHarness;
  let api: ReturnType<typeof createApi>;
  let auth: ReturnType<typeof createOpenMuseAuth>;
  let clientA: OpenMuseClient;
  let clientB: OpenMuseClient;
  let bearerTokenA = "";

  beforeAll(async () => {
    harness = await provisionIntegrationDatabase();
    auth = createOpenMuseAuth(harness.auth, {
      secret: authSecret,
      baseURL: "http://localhost:8787",
      trustedOrigins: [origin],
      secureCookies: false,
      environment: "test",
    });
    const catalog = new ProviderCatalog(
      createBuiltinProviderRegistry({
        deterministic: true,
        deterministicResponse: "worker response",
      }),
    );
    api = createApi({
      db: harness.runtime,
      auth,
      allowedOrigins: [origin],
      providerCatalog: catalog,
      credentialEncryptionKey: encryptionKey,
    });
    bearerTokenA = await signIn(`a-${harness.ids.userA}@example.test`);
    clientA = createClient(bearerTokenA);
  }, 30_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

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

  function createClient(token: string): OpenMuseClient {
    return createApiClient({
      baseUrl: "http://localhost:8787",
      getAccessToken: () => token,
      fetch: async (input, init) => api.request(input, init),
    });
  }

  it("replays the provider migration and keeps BYOK metadata-only", async () => {
    const applied = await harness.owner.sql<{ version: string }[]>`
      select version from openmuse_schema_migrations order by version
    `;
    expect(applied.map((row) => row.version)).toContain("0007_chat_provider_pinning");
    expect(new Set(applied.map((row) => row.version)).size).toBe(applied.length);
    expect(applied.map((row) => row.version)).toContain("0008_chat_task_rls");

    const columns = await harness.owner.sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'provider_credentials' and column_name in ('provider_instance_id', 'secret_revision'))
          or (table_name = 'provider_instance_defaults' and column_name = 'provider_instance_id')
          or (table_name = 'runs' and column_name in ('provider_instance_id', 'config_digest', 'current_event_sequence'))
        )
      order by table_name, column_name
    `;
    expect(columns).toEqual(
      expect.arrayContaining([
        { table_name: "provider_credentials", column_name: "provider_instance_id" },
        { table_name: "provider_credentials", column_name: "secret_revision" },
        { table_name: "provider_instance_defaults", column_name: "provider_instance_id" },
        { table_name: "runs", column_name: "config_digest" },
        { table_name: "runs", column_name: "current_event_sequence" },
        { table_name: "runs", column_name: "provider_instance_id" },
      ]),
    );
    const [rls] = await harness.runtime.sql.begin(async (tx) => {
      await tx`
        select set_config('app.workspace_id', ${harness.ids.workspace}, true),
               set_config('app.actor_id', ${harness.ids.userA}, true)
      `;
      return tx<{ member: boolean; conversation: boolean; run: boolean }[]>`
        select
          openmuse_is_member(${harness.ids.workspace}) as member,
          openmuse_can_read_conversation(${harness.ids.conversation}) as conversation,
          openmuse_can_read_run(${harness.ids.run}) as run
      `;
    });
    expect(rls).toEqual({ member: true, conversation: true, run: true });

    const instance = await clientA.createProviderInstance({
      providerId: "openai-compatible",
      module: "model",
      scope: "workspace",
      displayName: "Integration BYOK model",
      config: {},
    });
    expect(instance.scope).toBe("workspace");
    expect(instance.requiredSecrets).toEqual([
      { name: "apiKeySecret", required: true, configured: false },
    ]);

    const credential = await clientA.createProviderCredential({
      providerId: "openai-compatible",
      providerInstanceId: instance.id,
      credentialKind: "apiKeySecret",
      scope: "workspace",
      secret: credentialSecret,
    });
    expect(credential.secretRevision).toBe(1);
    expect(JSON.stringify(credential)).not.toContain(credentialSecret);
    expect(JSON.stringify(credential)).not.toMatch(/encrypted[_-]?value|ciphertext/i);

    const rawCredential = await api.request(
      request(`/api/v1/provider-credentials/${credential.id}`, {
        headers: { Authorization: `Bearer ${bearerTokenA}` },
      }),
    );
    expect(rawCredential.status).toBe(200);
    const rawCredentialBody = await rawCredential.text();
    expect(rawCredentialBody).not.toContain(credentialSecret);
    expect(rawCredentialBody).not.toMatch(/encrypted[_-]?value|ciphertext/i);

    const updatedInstance = await clientA.updateProviderInstance(instance.id, {
      credentialBindings: [{ name: "apiKeySecret", credentialId: credential.id }],
      expectedConfigDigest: instance.configDigest,
    });
    expect(updatedInstance.configDigest).not.toBe(instance.configDigest);
    expect(updatedInstance.requiredSecrets).toEqual([
      { name: "apiKeySecret", required: true, configured: true },
    ]);

    const rotated = await clientA.updateProviderCredential(credential.id, {
      secret: `${credentialSecret}-rotated`,
    });
    expect(rotated.secretRevision).toBe(2);
    expect(JSON.stringify(rotated)).not.toContain(credentialSecret);
    const [storedCredential] = await harness.owner.sql<
      { encrypted_value: string; secret_revision: number }[]
    >`
      select encrypted_value, secret_revision
      from provider_credentials
      where id = ${credential.id}
    `;
    expect(storedCredential?.secret_revision).toBe(2);
    expect(storedCredential?.encrypted_value).toBeTruthy();
    expect(storedCredential?.encrypted_value).not.toContain(credentialSecret);

    const deterministic = await clientA.createProviderInstance({
      providerId: "deterministic",
      module: "model",
      scope: "workspace",
      displayName: "Integration deterministic model",
      config: {},
      isDefault: true,
    });
    expect(deterministic.isDefault).toBe(true);
    expect(deterministic.requiredSecrets).toEqual([]);
  });

  it("atomically submits and executes a registered deterministic provider", async () => {
    const clientMessageId = `chat-message-${harness.databaseName}`;
    const result = await clientA.sendMessage({
      conversationId: harness.ids.conversation,
      clientMessageId,
      parts: [{ type: "text", text: "Say hello from the PostgreSQL integration." }],
    });
    expect(result.message.author).toEqual({ type: "user", userId: harness.ids.userA });
    expect(result.message.runId).toBe(result.run.id);
    expect(result.run.status).toBe("queued");
    expect(result.run.providerInstanceId).toBeTruthy();

    const submissionRows = await harness.owner.sql<
      {
        message_id: string;
        message_run_id: string | null;
        run_id: string;
        task_run_id: string | null;
        task_status: string;
        event_type: string;
        event_sequence: number;
        run_sequence: number;
      }[]
    >`
      select
        m.id as message_id,
        m.run_id as message_run_id,
        r.id as run_id,
        t.run_id as task_run_id,
        t.status as task_status,
        e.event_type,
        e.sequence as event_sequence,
        r.current_event_sequence as run_sequence
      from messages m
      inner join runs r on r.id = m.run_id
      inner join tasks t on t.run_id = r.id
      inner join run_events e on e.run_id = r.id
      where m.id = ${result.message.id}
    `;
    expect(submissionRows).toHaveLength(1);
    expect(submissionRows[0]).toMatchObject({
      message_id: result.message.id,
      message_run_id: result.run.id,
      run_id: result.run.id,
      task_run_id: result.run.id,
      task_status: "queued",
      event_type: "run.created",
      event_sequence: 1,
      run_sequence: 1,
    });

    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const providerRuntime = new WorkerProviderRuntime({
      db: harness.runtime.db,
      encryptionKey,
      deterministic: true,
      deterministicResponse: "worker response",
    });
    const handler = new ConversationTaskHandler({
      db: harness.runtime.db,
      resolveModel: (payload, context, task) =>
        providerRuntime.resolveModel(payload, context, task),
    });
    const worker = new DurableWorker(harness.runtime, {
      workerId: `chat-integration-worker-${harness.databaseName}`,
      scopes: [{ workspaceId: harness.ids.workspace, actorId: harness.ids.userA }],
      handlers: [handler],
      pollMs: 250,
      onError: (error) => {
        throw error;
      },
    });
    const workerRun = worker.run();
    try {
      const completed = await waitForRun(
        clientA,
        result.run.id,
        (run) => run.status === "succeeded",
      );
      expect(completed.status).toBe("succeeded");
      expect(completed.currentEventSequence).toBeGreaterThanOrEqual(6);
    } finally {
      worker.stop("chat integration complete");
      await workerRun;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }

    const messages = await clientA.listMessages(harness.ids.conversation);
    const assistant = messages.items.find(
      (message) => message.runId === result.run.id && message.author.type === "assistant",
    );
    expect(assistant?.author).toEqual({ type: "assistant" });
    expect(assistant?.parts).toEqual([{ type: "text", text: "worker response" }]);

    const events = await clientA.listRunEvents({ runId: result.run.id, limit: 100 });
    expect(events.items.map((event) => event.type)).toEqual([
      "run.created",
      "run.started",
      "message.delta",
      "run.progress",
      "run.progress",
      "message.completed",
      "run.completed",
    ]);
    expect(events.items.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.items.find((event) => event.type === "message.delta")?.payload).toEqual({
      text: "worker response",
    });
  });

  it("cancels queued work and keeps private conversations owner-only", async () => {
    const clientMessageId = `cancel-message-${harness.databaseName}`;
    const submitted = await clientA.sendMessage({
      conversationId: harness.ids.conversation,
      clientMessageId,
      parts: [{ type: "text", text: "This message will be cancelled." }],
    });
    const cancelled = await clientA.cancelRun(submitted.run.id, {
      reason: "integration cancellation",
    });
    expect(cancelled.status).toBe("cancelled");

    const cancelledEvents = await clientA.listRunEvents({ runId: submitted.run.id, limit: 100 });
    expect(cancelledEvents.items.map((event) => event.type)).toEqual([
      "run.created",
      "run.cancelled",
    ]);

    const [task] = await harness.owner.sql<{ status: string }[]>`
      select status from tasks where run_id = ${submitted.run.id}
    `;
    expect(task?.status).toBe("cancelled");

    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const providerRuntime = new WorkerProviderRuntime({
      db: harness.runtime.db,
      encryptionKey,
      deterministic: true,
      deterministicResponse: "must not execute",
    });
    const worker = new DurableWorker(harness.runtime, {
      workerId: `cancel-integration-worker-${harness.databaseName}`,
      scopes: [{ workspaceId: harness.ids.workspace, actorId: harness.ids.userA }],
      handlers: [
        new ConversationTaskHandler({
          db: harness.runtime.db,
          resolveModel: (payload, context, taskRecord) =>
            providerRuntime.resolveModel(payload, context, taskRecord),
        }),
      ],
      pollMs: 250,
    });
    const workerRun = worker.run();
    try {
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect((await clientA.getRun(submitted.run.id)).status).toBe("cancelled");
      const afterWorkerEvents = await clientA.listRunEvents({
        runId: submitted.run.id,
        limit: 100,
      });
      expect(afterWorkerEvents.items.map((event) => event.type)).toEqual([
        "run.created",
        "run.cancelled",
      ]);
    } finally {
      worker.stop("cancel integration complete");
      await workerRun;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }

    bearerTokenA = await signIn(`a-${harness.ids.userA}@example.test`);
    clientA = createClient(bearerTokenA);
    const bearerTokenB = await signIn(`b-${harness.ids.userB}@example.test`);
    clientB = createClient(bearerTokenB);
    await expect(clientB.getConversation(harness.ids.conversation)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      clientB.sendMessage({
        conversationId: harness.ids.conversation,
        parts: [{ type: "text", text: "private access" }],
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      clientB.updateProviderInstance(submitted.run.providerInstanceId ?? "missing", {
        displayName: "member takeover",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

async function waitForRun(
  client: OpenMuseClient,
  runId: string,
  predicate: (run: Awaited<ReturnType<OpenMuseClient["getRun"]>>) => boolean,
): Promise<Awaited<ReturnType<OpenMuseClient["getRun"]>>> {
  const deadline = Date.now() + 10_000;
  let latest = await client.getRun(runId);
  while (!predicate(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = await client.getRun(runId);
  }
  expect(predicate(latest)).toBe(true);
  return latest;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost:8787${path}`, init);
}
