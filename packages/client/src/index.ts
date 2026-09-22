import { z } from "zod";
import {
  apiEnvelopeSchema,
  apiFailureSchema,
  apiErrorSchema,
  approvalSchema,
  artifactSchema,
  cancelRunInputSchema,
  changeGoalStatusInputSchema,
  completeConnectionIntentInputSchema,
  connectionSchema,
  conversationSchema,
  createArtifactInputSchema,
  createConnectionIntentInputSchema,
  createConversationInputSchema,
  createGoalInputSchema,
  createMemoryInputSchema,
  createSessionInputSchema,
  createShareInputSchema,
  createWorkspaceInputSchema,
  decideApprovalInputSchema,
  goalSchema,
  listEventsInputSchema,
  listProvidersInputSchema,
  listSharesInputSchema,
  memorySchema,
  messageSchema,
  providerInstanceSchema,
  runEventSchema,
  runSchema,
  sendMessageInputSchema,
  sessionSchema,
  shareSchema,
  updateConversationInputSchema,
  updateGoalInputSchema,
  updateMemoryInputSchema,
  updateWorkspaceInputSchema,
  workspaceSchema,
  type Approval,
  type Artifact,
  type CancelRunInput,
  type ChangeGoalStatusInput,
  type CompleteConnectionIntentInput,
  type Connection,
  type Conversation,
  type CreateArtifactInput,
  type CreateConnectionIntentInput,
  type CreateConversationInput,
  type CreateGoalInput,
  type CreateMemoryInput,
  type CreateSessionInput,
  type CreateShareInput,
  type CreateWorkspaceInput,
  type DecideApprovalInput,
  type Goal,
  type ListEventsInput,
  type ListProvidersInput,
  type ListSharesInput,
  type Memory,
  type Message,
  type Page,
  type PaginationInput,
  type ProviderInstance,
  type Run,
  type RunEvent,
  type SendMessageInput,
  type Session,
  type Share,
  type UpdateConversationInput,
  type UpdateGoalInput,
  type UpdateMemoryInput,
  type UpdateWorkspaceInput,
  type Workspace,
} from "@openmuse/contracts";

export interface FetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  getAccessToken?: () => string | undefined | Promise<string | undefined>;
  onUnauthorized?: () => void;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, error: z.infer<typeof apiErrorSchema>) {
    super(error.message);
    this.name = "ApiClientError";
    this.status = status;
    this.requestId = error.requestId;
    this.code = error.code;
    this.details = error.details;
  }
}

export interface ResourceListInput extends PaginationInput {}
export interface ListMessagesInput extends PaginationInput {}
export interface ListApprovalsInput extends PaginationInput { status?: Approval["status"] }
export interface ListConnectionsInput extends PaginationInput { status?: Connection["status"] }
export interface ListArtifactsInput extends PaginationInput { runId?: string }
export interface ListMemoryInput extends PaginationInput { scope?: Memory["scope"] }

export interface SendMessageResult {
  message: Message;
  run?: Run;
}

export type RunEventsInput = Omit<ListEventsInput, "runId"> & { runId: string };

const sendMessageResultSchema = z.object({ message: messageSchema, run: runSchema.optional() });
const emptySchema = z.undefined();

function encode(value: string): string {
  return encodeURIComponent(value);
}

function query(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return apiEnvelopeSchema(z.object({ items: z.array(item), page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }) }));
}

export interface EventsTransport {
  listRunEvents(input: RunEventsInput): Promise<Page<RunEvent>>;
  pollRunEvents(
    runId: string,
    options?: Omit<ListEventsInput, "runId" | "cursor"> & { cursor?: string; pollMs?: number },
  ): AsyncIterable<RunEvent>;
}

export interface OpenMuseClient extends EventsTransport {
  createSession(input?: CreateSessionInput): Promise<Session>;
  getCurrentSession(): Promise<Session>;
  revokeSession(sessionId: string): Promise<void>;

  listWorkspaces(input?: ResourceListInput): Promise<Page<Workspace>>;
  createWorkspace(input: CreateWorkspaceInput): Promise<Workspace>;
  updateWorkspace(workspaceId: string, input: UpdateWorkspaceInput): Promise<Workspace>;

  listConversations(workspaceId: string, input?: ResourceListInput): Promise<Page<Conversation>>;
  getConversation(conversationId: string): Promise<Conversation>;
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  updateConversation(conversationId: string, input: UpdateConversationInput): Promise<Conversation>;

  listMessages(conversationId: string, input?: ListMessagesInput): Promise<Page<Message>>;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;

  getRun(runId: string): Promise<Run>;
  cancelRun(runId: string, input?: CancelRunInput): Promise<Run>;

  listGoals(workspaceId: string, input?: ResourceListInput): Promise<Page<Goal>>;
  getGoal(goalId: string): Promise<Goal>;
  createGoal(input: CreateGoalInput): Promise<Goal>;
  updateGoal(goalId: string, input: UpdateGoalInput): Promise<Goal>;
  changeGoalStatus(goalId: string, input: ChangeGoalStatusInput): Promise<Goal>;

  listProviders(input?: ListProvidersInput): Promise<ProviderInstance[]>;

  listConnections(workspaceId: string, input?: ListConnectionsInput): Promise<Page<Connection>>;
  createConnectionIntent(input: CreateConnectionIntentInput): Promise<{ intentId: string; authorizationUrl: string; expiresAt: string }>;
  completeConnectionIntent(input: CompleteConnectionIntentInput): Promise<Connection>;
  revokeConnection(connectionId: string): Promise<Connection>;

  listApprovals(input?: ListApprovalsInput): Promise<Page<Approval>>;
  getApproval(approvalId: string): Promise<Approval>;
  decideApproval(approvalId: string, input: DecideApprovalInput): Promise<Approval>;

  listArtifacts(workspaceId: string, input?: ListArtifactsInput): Promise<Page<Artifact>>;
  getArtifact(artifactId: string): Promise<Artifact>;
  createArtifact(input: CreateArtifactInput): Promise<Artifact>;

  listMemory(workspaceId: string, input?: ListMemoryInput): Promise<Page<Memory>>;
  getMemory(memoryId: string): Promise<Memory>;
  createMemory(input: CreateMemoryInput): Promise<Memory>;
  updateMemory(memoryId: string, input: UpdateMemoryInput): Promise<Memory>;
  deleteMemory(memoryId: string): Promise<void>;

  listShares(input?: ListSharesInput): Promise<Page<Share>>;
  createShare(input: CreateShareInput): Promise<Share>;
  revokeShare(shareId: string): Promise<Share>;
}

export function createApiClient(options: ApiClientOptions): OpenMuseClient {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const root = options.baseUrl.replace(/\/$/, "");

  async function request<T>(method: string, path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const token = await options.getAccessToken?.();
    const headers = new Headers({ Accept: "application/json" });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetcher(`${root}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const raw = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      const parsed = apiFailureSchema.safeParse(raw);
      if (parsed.success) throw new ApiClientError(response.status, parsed.data.error);
      throw new ApiClientError(response.status, {
        code: "internal",
        message: `OpenMuse request failed with HTTP ${response.status}.`,
      });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ApiClientError(502, { code: "internal", message: "OpenMuse returned an invalid response." });
    return parsed.data;
  }

  async function get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    return request("GET", path, undefined, schema, signal);
  }
  async function post<T>(path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    return request("POST", path, body, schema, signal);
  }
  async function patch<T>(path: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    return request("PATCH", path, body, schema, signal);
  }
  async function del<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    return request("DELETE", path, undefined, schema, signal);
  }
  async function page<T>(path: string, item: z.ZodType<T>): Promise<Page<T>> {
    const response = await get(path, pageSchema(item));
    return response.data;
  }
  async function item<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await get(path, apiEnvelopeSchema(schema));
    return response.data;
  }
  async function mutate<T>(method: "POST" | "PATCH", path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const response = await request(method, path, body, apiEnvelopeSchema(schema));
    return response.data;
  }

  const client: OpenMuseClient = {
    async createSession(input = {}) { return (await mutate("POST", "/api/v1/sessions", createSessionInputSchema.parse(input), sessionSchema)); },
    async getCurrentSession() { return item("/api/v1/sessions/current", sessionSchema); },
    async revokeSession(sessionId) { await del(`/api/v1/sessions/${encode(sessionId)}`, emptySchema); },

    async listWorkspaces(input = {}) { return page(`/api/v1/workspaces${query(input)}`, workspaceSchema); },
    async createWorkspace(input) { return mutate("POST", "/api/v1/workspaces", createWorkspaceInputSchema.parse(input), workspaceSchema); },
    async updateWorkspace(workspaceId, input) { return mutate("PATCH", `/api/v1/workspaces/${encode(workspaceId)}`, updateWorkspaceInputSchema.parse(input), workspaceSchema); },

    async listConversations(workspaceId, input = {}) { return page(`/api/v1/workspaces/${encode(workspaceId)}/conversations${query(input)}`, conversationSchema); },
    async getConversation(conversationId) { return item(`/api/v1/conversations/${encode(conversationId)}`, conversationSchema); },
    async createConversation(input) { return mutate("POST", "/api/v1/conversations", createConversationInputSchema.parse(input), conversationSchema); },
    async updateConversation(conversationId, input) { return mutate("PATCH", `/api/v1/conversations/${encode(conversationId)}`, updateConversationInputSchema.parse(input), conversationSchema); },

    async listMessages(conversationId, input = {}) { return page(`/api/v1/conversations/${encode(conversationId)}/messages${query(input)}`, messageSchema); },
    async sendMessage(input) {
      const response = await request("POST", `/api/v1/conversations/${encode(input.conversationId)}/messages`, sendMessageInputSchema.parse(input), apiEnvelopeSchema(sendMessageResultSchema));
      return response.data;
    },

    async getRun(runId) { return item(`/api/v1/runs/${encode(runId)}`, runSchema); },
    async cancelRun(runId, input = {}) { return mutate("POST", `/api/v1/runs/${encode(runId)}/cancel`, cancelRunInputSchema.parse(input), runSchema); },

    async listRunEvents(input) { return page(`/api/v1/runs/${encode(input.runId)}/events${query({ cursor: input.cursor, limit: input.limit, waitSeconds: input.waitSeconds })}`, runEventSchema); },

    async listGoals(workspaceId, input = {}) { return page(`/api/v1/workspaces/${encode(workspaceId)}/goals${query(input)}`, goalSchema); },
    async getGoal(goalId) { return item(`/api/v1/goals/${encode(goalId)}`, goalSchema); },
    async createGoal(input) { return mutate("POST", "/api/v1/goals", createGoalInputSchema.parse(input), goalSchema); },
    async updateGoal(goalId, input) { return mutate("PATCH", `/api/v1/goals/${encode(goalId)}`, updateGoalInputSchema.parse(input), goalSchema); },
    async changeGoalStatus(goalId, input) { return mutate("POST", `/api/v1/goals/${encode(goalId)}/status`, changeGoalStatusInputSchema.parse(input), goalSchema); },

    async listProviders(input = {}) {
      const response = await get(`/api/v1/providers${query(input)}`, apiEnvelopeSchema(z.object({ items: z.array(providerInstanceSchema) })));
      return response.data.items;
    },

    async listConnections(workspaceId, input = {}) { return page(`/api/v1/workspaces/${encode(workspaceId)}/connections${query(input)}`, connectionSchema); },
    async createConnectionIntent(input) {
      const schema = z.object({ intentId: z.string().min(1), authorizationUrl: z.string().url(), expiresAt: z.string().min(1) });
      return mutate("POST", "/api/v1/connections/intents", createConnectionIntentInputSchema.parse(input), schema);
    },
    async completeConnectionIntent(input) { return mutate("POST", "/api/v1/connections/intents/complete", completeConnectionIntentInputSchema.parse(input), connectionSchema); },
    async revokeConnection(connectionId) { return mutate("POST", `/api/v1/connections/${encode(connectionId)}/revoke`, {}, connectionSchema); },

    async listApprovals(input = {}) { return page(`/api/v1/approvals${query(input)}`, approvalSchema); },
    async getApproval(approvalId) { return item(`/api/v1/approvals/${encode(approvalId)}`, approvalSchema); },
    async decideApproval(approvalId, input) { return mutate("POST", `/api/v1/approvals/${encode(approvalId)}/decision`, decideApprovalInputSchema.parse(input), approvalSchema); },

    async listArtifacts(workspaceId, input = {}) { return page(`/api/v1/workspaces/${encode(workspaceId)}/artifacts${query(input)}`, artifactSchema); },
    async getArtifact(artifactId) { return item(`/api/v1/artifacts/${encode(artifactId)}`, artifactSchema); },
    async createArtifact(input) { return mutate("POST", "/api/v1/artifacts", createArtifactInputSchema.parse(input), artifactSchema); },

    async listMemory(workspaceId, input = {}) { return page(`/api/v1/workspaces/${encode(workspaceId)}/memory${query(input)}`, memorySchema); },
    async getMemory(memoryId) { return item(`/api/v1/memory/${encode(memoryId)}`, memorySchema); },
    async createMemory(input) { return mutate("POST", "/api/v1/memory", createMemoryInputSchema.parse(input), memorySchema); },
    async updateMemory(memoryId, input) { return mutate("PATCH", `/api/v1/memory/${encode(memoryId)}`, updateMemoryInputSchema.parse(input), memorySchema); },
    async deleteMemory(memoryId) { await del(`/api/v1/memory/${encode(memoryId)}`, emptySchema); },

    async listShares(input = {}) { return page(`/api/v1/shares${query(input)}`, shareSchema); },
    async createShare(input) { return mutate("POST", "/api/v1/shares", createShareInputSchema.parse(input), shareSchema); },
    async revokeShare(shareId) { return mutate("POST", `/api/v1/shares/${encode(shareId)}/revoke`, {}, shareSchema); },

    async *pollRunEvents(runId, options = {}) {
      let cursor = options.cursor;
      const pollMs = options.pollMs ?? 1000;
      while (true) {
        const pageResult = await client.listRunEvents({ runId, cursor, limit: options.limit, waitSeconds: options.waitSeconds });
        for (const event of pageResult.items) yield event;
        if (!pageResult.page.hasMore || !pageResult.page.nextCursor) return;
        cursor = pageResult.page.nextCursor ?? cursor;
        if (pageResult.items.length === 0 && pollMs > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
  };

  return client;
}

export type { Page, PaginationInput };
