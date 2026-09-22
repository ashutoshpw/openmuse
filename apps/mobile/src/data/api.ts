import { ApiClientError, createApiClient, type OpenMuseClient } from "@openmuse/client";
import type {
  Approval as ContractApproval,
  Artifact as ContractArtifact,
  Connection as ContractConnection,
  Conversation as ContractConversation,
  Goal as ContractGoal,
  Memory as ContractMemory,
  Message as ContractMessage,
  ProviderInstance,
  RunEvent,
  Session as ContractSession,
  Share as ContractShare,
  Workspace as ContractWorkspace,
} from "@openmuse/contracts";
import { requireApiUrl } from "../config";
import type {
  Approval,
  Artifact,
  Attachment,
  ChatPart,
  Conversation,
  Goal,
  ListResult,
  Memory,
  ProviderConnection,
  Session,
  ShareSnapshot,
  SignInInput,
  StreamEvent,
  User,
  Workspace,
} from "./model";
import { OpenMuseApiError } from "./model";
import { saveProviderSetup as saveProviderSetupFlow } from "./provider-setup";

export type ApiConfig = {
  baseUrl?: string | null;
  token?: string | null;
  workspaceId?: string | null;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new OpenMuseApiError(`The server returned an invalid ${field}.`, "invalid");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function unwrapEnvelope(value: unknown): unknown {
  if (!isRecord(value) || !("data" in value)) return value;
  return value.data;
}

function page<T>(value: { items: T[]; page: { nextCursor: string | null } }): ListResult<T> {
  return { items: value.items, nextCursor: value.page.nextCursor ?? undefined };
}

function userFromAuth(value: JsonRecord): User {
  const user = isRecord(value.user)
    ? value.user
    : isRecord(value.session) && isRecord(value.session.user)
      ? value.session.user
      : null;
  if (!user)
    throw new OpenMuseApiError("The server did not return an authenticated user.", "invalid");
  return {
    id: requiredString(user.id, "user id"),
    name: requiredString(user.name ?? user.email, "user name"),
    email: optionalString(user.email),
    avatarUrl: optionalString(user.image ?? user.avatarUrl),
  };
}

function sessionFromAuth(value: unknown): Session {
  const item = unwrapEnvelope(value);
  if (!isRecord(item))
    throw new OpenMuseApiError("The server returned an invalid sign-in response.", "invalid");
  const nestedSession = isRecord(item.session) ? item.session : {};
  const token = item.token ?? item.accessToken ?? item.sessionToken ?? nestedSession.token;
  return {
    token: requiredString(token, "session token"),
    sessionId: optionalString(item.sessionId ?? nestedSession.id),
    user: userFromAuth(item),
    workspaceId: optionalString(item.workspaceId ?? nestedSession.workspaceId),
  };
}

function sessionFromContract(value: ContractSession): Session {
  return {
    token: "",
    sessionId: value.id,
    user: { id: value.userId, name: value.userId },
  };
}

function workspaceFromContract(value: ContractWorkspace): Workspace {
  return { id: value.id, name: value.name, role: value.role };
}

function conversationFromContract(value: ContractConversation): Conversation {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    title: value.title,
    updatedAt: value.updatedAt,
    status: value.status === "active" ? "idle" : "paused",
  };
}

function textFromMessage(value: ContractMessage): string {
  return value.parts
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return part.text;
      if (part.type === "citation") return `${part.title ?? part.url}`;
      if (part.type === "toolCall") return `Calling ${part.name}`;
      if (part.type === "toolResult")
        return part.ok ? "Tool completed" : (part.error ?? "Tool failed");
      if (part.type === "approvalRef") return "Approval requested";
      return "Attachment";
    })
    .filter(Boolean)
    .join("\n");
}

function chatPartFromContract(
  value: ContractMessage,
  conversationId = value.conversationId,
): ChatPart {
  const author = value.author;
  const firstPart = value.parts[0];
  return {
    id: value.id,
    conversationId,
    role: author.type,
    text: textFromMessage(value),
    createdAt: value.createdAt,
    streaming: value.status === "streaming",
    kind: firstPart?.type,
    toolName:
      author.type === "tool"
        ? author.toolName
        : firstPart?.type === "toolCall"
          ? firstPart.name
          : undefined,
    artifactId: firstPart && "artifactId" in firstPart ? firstPart.artifactId : undefined,
  };
}

function artifactFromContract(value: ContractArtifact): Artifact {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    title: value.name,
    kind: value.kind,
    mimeType: value.mimeType,
    size: value.sizeBytes,
    url: value.downloadUrl ?? undefined,
    createdAt: value.createdAt,
  };
}

function scheduleLabel(value: ContractGoal["schedule"]): string | undefined {
  if (!value) return undefined;
  if (value.kind === "cron") return `cron: ${value.expression}`;
  if (value.kind === "interval") return `every ${value.everySeconds}s`;
  return `once: ${value.at}`;
}

function goalFromContract(value: ContractGoal): Goal {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    title: value.title,
    detail: value.instructions,
    status: value.status,
    nextRunAt: value.nextRunAt ?? undefined,
    schedule: scheduleLabel(value.schedule),
    revision: value.revision,
  };
}

function approvalFromContract(value: ContractApproval): Approval {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    title: `Approval for ${value.target.action ?? value.target.name ?? "a provider action"}`,
    detail: typeof value.target.description === "string" ? value.target.description : undefined,
    action: typeof value.target.action === "string" ? value.target.action : undefined,
    status: value.status,
    digest: value.digest,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function providerFromCatalog(value: ProviderInstance): ProviderConnection {
  return {
    id: value.id,
    provider: value.providerId,
    label: value.displayName,
    status: value.status === "available" ? "disconnected" : value.status,
    scopes: value.capabilities.map((capability) => capability.key),
    supportsByok: value.requiredSecrets.some((secret) => secret.configured || secret.required),
  };
}

function connectionFromContract(value: ContractConnection): ProviderConnection {
  return {
    id: value.id,
    provider: value.providerId,
    label: value.displayName,
    status: value.status,
    scopes: value.scopes,
    accountLabel: value.accountRef,
  };
}

function memoryFromContract(value: ContractMemory): Memory {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    title: value.title,
    text: value.content,
    source: value.source,
    updatedAt: value.updatedAt,
    enabled: value.deletedAt === null,
    version: value.version,
    sensitivity: value.sensitivity,
  };
}

function shareFromContract(value: ContractShare): ShareSnapshot {
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    resourceType: value.resourceType,
    resourceId: value.resourceId,
    title: `${value.resourceType} share`,
    visibility: value.status,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt ?? undefined,
    readOnly: true,
  };
}

function scheduleInput(
  value?: string,
):
  | { kind: "once"; at: string }
  | { kind: "interval"; everySeconds: number; timezone: string }
  | { kind: "cron"; expression: string; timezone: string }
  | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized.startsWith("cron:"))
    return { kind: "cron", expression: normalized.slice(5).trim(), timezone: "UTC" };
  const interval = normalized.match(/^(?:every\s+)?(\d+)\s*(?:s|sec|secs|second|seconds)$/i);
  if (interval)
    return { kind: "interval", everySeconds: Math.max(60, Number(interval[1])), timezone: "UTC" };
  if (/^(daily|every day)$/i.test(normalized))
    return { kind: "cron", expression: "0 9 * * *", timezone: "UTC" };
  if (/^(weekly|every week)$/i.test(normalized))
    return { kind: "cron", expression: "0 9 * * 1", timezone: "UTC" };
  throw new OpenMuseApiError(
    "Use a cron: expression, daily, weekly, or an interval in seconds.",
    "invalid",
  );
}

function attachmentFromRaw(value: unknown): Attachment {
  if (!isRecord(value))
    throw new OpenMuseApiError("The server returned an invalid attachment.", "invalid");
  return {
    id: requiredString(value.id, "attachment id"),
    name: requiredString(value.name, "attachment name"),
    mimeType: requiredString(value.mimeType, "attachment type"),
    size: typeof value.size === "number" ? value.size : undefined,
    url: optionalString(value.url),
    status: optionalString(value.status),
  };
}

function attachmentListFromRaw(value: unknown): ListResult<Attachment> {
  const item = unwrapEnvelope(value);
  if (!isRecord(item) || !Array.isArray(item.items))
    throw new OpenMuseApiError("The server returned an invalid attachment list.", "invalid");
  return { items: item.items.map(attachmentFromRaw) };
}

export class OpenMuseApi {
  readonly baseUrl: string;
  private readonly token: string | null;
  readonly workspaceId: string | null;
  private readonly client: OpenMuseClient;

  private constructor(
    baseUrl: string,
    token: string | null,
    workspaceId: string | null,
    client: OpenMuseClient,
  ) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.workspaceId = workspaceId;
    this.client = client;
  }

  static create(config: ApiConfig = {}) {
    const baseUrl = (config.baseUrl ?? requireApiUrl()).replace(/\/$/, "");
    const token = config.token ?? null;
    const workspaceId = config.workspaceId ?? null;
    const client = createApiClient({
      baseUrl,
      getAccessToken: () => token ?? undefined,
      getWorkspaceId: () => workspaceId ?? undefined,
    });
    return Promise.resolve(new OpenMuseApi(baseUrl, token, workspaceId, client));
  }

  withToken(token: string | null) {
    return OpenMuseApi.create({ baseUrl: this.baseUrl, token, workspaceId: this.workspaceId });
  }

  withWorkspace(workspaceId: string | null) {
    return OpenMuseApi.create({ baseUrl: this.baseUrl, token: this.token, workspaceId });
  }

  private async raw<T>(path: string, init: RequestInit, parse: (value: unknown) => T): Promise<T> {
    if (typeof fetch !== "function")
      throw new OpenMuseApiError("This device does not provide a network transport.", "network");
    const headers = new Headers({ Accept: "application/json" });
    if (!(typeof FormData !== "undefined" && init.body instanceof FormData))
      headers.set("Content-Type", "application/json");
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (this.workspaceId) headers.set("X-OpenMuse-Workspace", this.workspaceId);
    if (init.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (cause: unknown) {
      throw new OpenMuseApiError(
        cause instanceof Error ? cause.message : "The network request failed.",
        "network",
      );
    }
    const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = isRecord(body) && isRecord(body.error) ? body.error : {};
      throw new OpenMuseApiError(
        typeof error.message === "string"
          ? error.message
          : `Request failed with status ${response.status}.`,
        response.status === 401 ? "unauthorized" : "server",
        response.status,
      );
    }
    return parse(body);
  }

  async getSession() {
    const current = await this.client.getCurrentSession();
    const session = sessionFromContract(current);
    return { ...session, token: this.token ?? "" };
  }

  async signIn(input: SignInInput) {
    return this.raw(
      "/api/auth/sign-in/email",
      { method: "POST", body: JSON.stringify({ email: input.email, password: input.password }) },
      sessionFromAuth,
    );
  }

  async signOut() {
    await this.raw("/api/auth/sign-out", { method: "POST" }, () => undefined);
  }

  async listWorkspaces() {
    const result = await this.client.listWorkspaces();
    return { ...page(result), items: result.items.map(workspaceFromContract) };
  }

  async createWorkspace(name: string) {
    return workspaceFromContract(await this.client.createWorkspace({ name }));
  }

  async listConversations(workspaceId: string) {
    const result = await this.client.listConversations(workspaceId);
    return { ...page(result), items: result.items.map(conversationFromContract) };
  }

  async createConversation(workspaceId: string, title?: string) {
    return conversationFromContract(
      await this.client.createConversation({
        workspaceId,
        title: title ?? "New conversation",
        visibility: "private",
      }),
    );
  }

  async getConversation(conversationId: string) {
    return conversationFromContract(await this.client.getConversation(conversationId));
  }

  async listChatParts(conversationId: string) {
    const result = await this.client.listMessages(conversationId);
    return {
      ...page(result),
      items: result.items.map((message) => chatPartFromContract(message, conversationId)),
    };
  }

  async sendMessage(conversationId: string, text: string, attachmentIds: string[] = []) {
    const result = await this.client.sendMessage({
      conversationId,
      parts: [
        { type: "text", text },
        ...attachmentIds.map((artifactId) => ({ type: "file" as const, artifactId })),
      ],
    });
    return chatPartFromContract(result.message, conversationId);
  }

  async streamMessage(
    conversationId: string,
    text: string,
    attachmentIds: string[],
    signal?: AbortSignal,
  ) {
    const result = await this.client.sendMessage({
      conversationId,
      parts: [
        { type: "text", text },
        ...attachmentIds.map((artifactId) => ({ type: "file" as const, artifactId })),
      ],
    });
    const client = this.client;
    return (async function* (): AsyncIterable<StreamEvent> {
      const run = result.run;
      let cancelPromise: Promise<unknown> | undefined;
      const cancelRun = () => {
        if (!run || typeof client.cancelRun !== "function" || cancelPromise) return;
        cancelPromise = client
          .cancelRun(run.id, { reason: "Stopped by the mobile client." })
          .catch(() => undefined);
      };
      const throwIfAborted = () => {
        if (!signal?.aborted) return;
        cancelRun();
        const error = new Error("The message stream was stopped.");
        error.name = "AbortError";
        throw error;
      };
      signal?.addEventListener("abort", cancelRun, { once: true });
      try {
        throwIfAborted();
        if (result.message.author.type !== "user") {
          yield { type: "part", part: chatPartFromContract(result.message, conversationId) };
        }
        if (run) {
          for await (const event of client.pollRunEvents(run.id, {
            pollMs: 500,
            waitSeconds: 5,
          })) {
            throwIfAborted();
            const streamEvent = streamEventFromRun(event, conversationId);
            if (streamEvent.type !== "done") yield streamEvent;
          }
        }
        throwIfAborted();
        yield { type: "done" };
      } finally {
        signal?.removeEventListener("abort", cancelRun);
      }
    })();
  }

  async listAttachments(conversationId: string) {
    return this.raw(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/attachments`,
      { method: "GET" },
      attachmentListFromRaw,
    );
  }

  async uploadAttachment(conversationId: string, body: FormData) {
    return this.raw(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/attachments`,
      { method: "POST", body },
      (value) => attachmentFromRaw(unwrapEnvelope(value)),
    );
  }

  async listArtifacts(conversationId: string, workspaceId?: string) {
    const result = await this.client.listArtifacts(workspaceId ?? conversationId);
    return { ...page(result), items: result.items.map(artifactFromContract) };
  }

  async listGoals(workspaceId: string) {
    const result = await this.client.listGoals(workspaceId);
    return { ...page(result), items: result.items.map(goalFromContract) };
  }

  async createGoal(
    workspaceId: string,
    input: { title: string; detail?: string; schedule?: string },
  ) {
    return goalFromContract(
      await this.client.createGoal({
        workspaceId,
        title: input.title,
        instructions: input.detail?.trim() || input.title,
        schedule: scheduleInput(input.schedule),
        connectionIds: [],
        memoryIds: [],
      }),
    );
  }

  async listApprovals(workspaceId: string) {
    const result = await this.client.listApprovals({ status: "pending" });
    return {
      ...page(result),
      items: result.items
        .filter((approval) => approval.workspaceId === workspaceId)
        .map(approvalFromContract),
    };
  }

  async decideApproval(approvalId: string, decision: "approve" | "deny", expectedDigest = "") {
    if (!expectedDigest)
      throw new OpenMuseApiError("This approval is missing its server digest.", "invalid");
    return approvalFromContract(
      await this.client.decideApproval(approvalId, { decision, expectedDigest }),
    );
  }

  async listProviders(_workspaceId: string) {
    const scoped = await this.withWorkspace(_workspaceId);
    const items = await scoped.client.listProviders({ includeUnavailable: true });
    return {
      items: items
        .filter((item) => item.workspaceId === null || item.workspaceId === _workspaceId)
        .map(providerFromCatalog),
    };
  }

  /** Return the typed catalog and configured instances for provider setup UI. */
  async listProviderCatalog(workspaceId: string) {
    const scoped = await this.withWorkspace(workspaceId);
    return (
      await scoped.client.listProviders({
        includeUnavailable: true,
      })
    ).filter((item) => item.workspaceId === null || item.workspaceId === workspaceId);
  }

  async listProviderInstances(workspaceId: string) {
    const scoped = await this.withWorkspace(workspaceId);
    return scoped.client.listProviderInstances({
      includeUnavailable: true,
    });
  }

  async listConnections(workspaceId: string) {
    const result = await this.client.listConnections(workspaceId);
    return { ...page(result), items: result.items.map(connectionFromContract) };
  }

  async saveProviderSetup(
    workspaceId: string,
    provider: ProviderInstance,
    input: {
      displayName?: string;
      config?: Record<string, unknown>;
      secrets?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const scoped = await this.withWorkspace(workspaceId);
    try {
      return await saveProviderSetupFlow({
        api: scoped.client,
        provider,
        displayName: input.displayName,
        config: input.config ?? {},
        secrets: input.secrets ?? {},
      });
    } catch (error) {
      // A CAS conflict means another actor changed the instance. Refresh the
      // catalog for the caller, but never replay the write-only secret.
      if (error instanceof ApiClientError && error.status === 409) {
        await scoped.client.listProviders({ includeUnavailable: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Compatibility wrapper for callers that only have a catalog provider id.
   * It still uses the typed instance/credential flow; no legacy credential
   * endpoint is available here.
   */
  async connectProvider(
    workspaceId: string,
    provider: string | ProviderInstance,
    input?: { apiKey?: string; redirectUri?: string },
  ) {
    const selected =
      typeof provider === "string"
        ? (await this.listProviderCatalog(workspaceId)).find(
            (item) => item.providerId === provider || item.id === provider,
          )
        : provider;
    if (!selected) throw new OpenMuseApiError("The selected provider is unavailable.", "invalid");
    const firstSecret = selected.requiredSecrets[0]?.name;
    return this.saveProviderSetup(workspaceId, selected, {
      secrets: firstSecret && input?.apiKey ? { [firstSecret]: input.apiKey } : {},
    });
  }

  async createProviderConnectionIntent(
    workspaceId: string,
    app: "gmail" | "calendar",
    returnPath?: string,
  ) {
    return this.client.createConnectionIntent({ workspaceId, app, returnPath });
  }

  async disconnectProvider(connectionId: string) {
    await this.client.revokeConnection(connectionId);
  }

  async listMemories(workspaceId: string) {
    const result = await this.client.listMemory(workspaceId);
    return { ...page(result), items: result.items.map(memoryFromContract) };
  }

  async updateMemory(
    memoryId: string,
    input: { text?: string; enabled?: boolean; title?: string; version?: number },
  ) {
    if (input.enabled === false) {
      await this.client.deleteMemory(memoryId);
      return { id: memoryId, text: "", enabled: false } satisfies Memory;
    }
    if (input.text === undefined && input.title === undefined)
      throw new OpenMuseApiError("Provide memory content or a title to update.", "invalid");
    return memoryFromContract(
      await this.client.updateMemory(memoryId, {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.text === undefined ? {} : { content: input.text }),
        expectedVersion: input.version ?? 1,
      }),
    );
  }

  async createMemory(
    workspaceId: string,
    input: {
      title: string;
      text: string;
      scope?: "user" | "workspace" | "conversation";
      sensitivity?: "private" | "workspace";
    },
  ) {
    return memoryFromContract(
      await this.client.createMemory({
        workspaceId,
        scope: input.scope ?? "workspace",
        title: input.title,
        content: input.text,
        sensitivity: input.sensitivity ?? "private",
      }),
    );
  }

  async forgetMemory(memoryId: string) {
    await this.client.deleteMemory(memoryId);
  }

  async listShares(workspaceId: string) {
    const result = await this.client.listShares();
    return {
      ...page(result),
      items: result.items
        .filter((share) => share.workspaceId === workspaceId)
        .map(shareFromContract),
    };
  }

  async createShare(
    workspaceId: string,
    input: { conversationId?: string; artifactId?: string; expiresAt?: string },
  ) {
    const resourceType = input.conversationId ? "conversation" : "artifact";
    const resourceId = input.conversationId ?? input.artifactId;
    if (!resourceId)
      throw new OpenMuseApiError("Choose a conversation or artifact to share.", "invalid");
    return shareFromContract(
      await this.client.createShare({
        resourceType,
        resourceId,
        subjectType: "workspace",
        subjectId: workspaceId,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      }),
    );
  }

  async revokeShare(shareId: string) {
    await this.client.revokeShare(shareId);
  }

  async handleAppConnectCallback(params: { code?: string; state?: string; error?: string }) {
    return this.raw(
      "/api/v1/connections/intents/complete",
      { method: "POST", body: JSON.stringify(params) },
      (value) => unwrapEnvelope(value),
    );
  }

  async createRealtimeVoiceSession(input: {
    offer: string;
    workspaceId?: string;
    conversationId?: string;
  }) {
    return this.raw(
      "/api/v1/voice/realtime/session",
      { method: "POST", body: JSON.stringify(input) },
      (value) => {
        const item = unwrapEnvelope(value);
        if (!isRecord(item) || typeof item.sdp !== "string" || item.sdp.length === 0)
          throw new OpenMuseApiError(
            "The server returned an invalid realtime voice answer.",
            "invalid",
          );
        return item;
      },
    );
  }

  async uploadVoiceRecording(input: {
    uri: string;
    mimeType?: string;
    workspaceId?: string;
    conversationId?: string;
  }) {
    const body = new FormData();
    body.append("file", {
      uri: input.uri,
      name: "voice-recording.m4a",
      type: input.mimeType ?? "audio/m4a",
    } as unknown as Blob);
    if (input.workspaceId) body.append("workspaceId", input.workspaceId);
    if (input.conversationId) body.append("conversationId", input.conversationId);
    return this.raw("/api/v1/voice/recordings", { method: "POST", body }, (value) =>
      unwrapEnvelope(value),
    );
  }
}

function streamEventFromRun(event: RunEvent, conversationId: string): StreamEvent {
  const payload = event.payload;
  if (event.type === "message.delta") {
    return {
      type: "delta",
      conversationId,
      partId: requiredString(payload.messageId ?? payload.partId ?? event.id, "message id"),
      text: requiredString(payload.text ?? payload.delta ?? payload.content, "message delta"),
    };
  }
  if (event.type === "run.waiting_approval")
    return { type: "status", conversationId, status: "paused" };
  if (event.type === "run.failed")
    return {
      type: "error",
      message: typeof payload.message === "string" ? payload.message : "The run failed.",
    };
  if (event.type === "run.started" || event.type === "run.progress")
    return { type: "status", conversationId, status: "running" };
  if (
    event.type === "run.completed" ||
    event.type === "run.cancelled" ||
    event.type === "message.completed"
  )
    return { type: "done" };
  return { type: "status", conversationId, status: "running" };
}
