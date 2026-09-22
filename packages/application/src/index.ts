import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createConversationInputSchema,
  createWorkspaceInputSchema,
  cancelRunInputSchema,
  listEventsInputSchema,
  sendMessageInputSchema,
  updateConversationInputSchema,
  updateWorkspaceInputSchema,
  type Conversation,
  type Message,
  type Run,
  type RunEvent,
  type SendMessageInput,
  type Workspace,
} from "@openmuse/contracts";
import type { ModelDriver } from "@openmuse/provider-contracts";
import {
  ApprovalRepository,
  ChatSubmissionRepository,
  ConversationRepository,
  ProviderInstanceRepository,
  RepositoryError,
  RunRepository,
  ScopedDatabase,
  TaskRepository,
  WorkspaceRepository,
  artifacts,
} from "@openmuse/db";
import type { ChatProviderSnapshot, ProviderBinding } from "@openmuse/db";

export class ApplicationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_request"
      | "unauthenticated"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "provider_unavailable"
      | "provider_auth_required"
      | "internal",
    readonly status: number,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export interface ApplicationProviderRegistry {
  resolveModel?(providerInstanceId?: string): Promise<ModelDriver | undefined>;
}

export interface ProviderCatalogLike {
  get(
    module: string,
    providerId: string,
  ): {
    module: string;
    providerId: string;
    version: string;
    configVersion: string;
    buildDigest: string;
  };
  digest(input: {
    module: string;
    providerId: string;
    version: string;
    configVersion: string;
    buildDigest: string;
    config: Record<string, unknown>;
    credentialBindings: readonly ProviderBinding[];
  }): string;
}

export interface ApplicationOptions {
  providers?: ApplicationProviderRegistry;
  providerCatalog?: ProviderCatalogLike;
  now?: () => Date;
}

export interface SendMessageOutcome {
  message: Message;
  run: Run;
}

function mapRepositoryError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof RepositoryError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "forbidden"
          ? 403
          : error.code === "expired"
            ? 410
            : error.code === "invalid"
              ? 400
              : 409;
    return new ApplicationError(
      error.message,
      error.code === "expired" || error.code === "invalid" ? "invalid_request" : error.code,
      status,
    );
  }
  return new ApplicationError("The request could not be completed.", "internal", 500);
}

function assertAllowedUserParts(input: SendMessageInput): void {
  // This check intentionally happens at the application boundary, even if a
  // caller bypasses the HTTP contract parser. Assistant/tool/reasoning parts
  // are server-authored and can never be smuggled into a user message.
  for (const part of input.parts) {
    if (
      part.type !== "text" &&
      part.type !== "file" &&
      part.type !== "image" &&
      part.type !== "audio"
    ) {
      throw new ApplicationError(
        "Only text, file, image, and audio parts may be sent by a user.",
        "invalid_request",
        400,
      );
    }
  }
}

function isProviderBinding(value: unknown): value is ProviderBinding {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { credentialId?: unknown }).credentialId === "string" &&
    typeof (value as { revision?: unknown }).revision === "number" &&
    Number.isInteger((value as { revision: number }).revision) &&
    (value as { revision: number }).revision > 0
  );
}

function toWorkspace(
  row: Awaited<ReturnType<WorkspaceRepository["get"]>>,
  role: Workspace["role"] = "member",
): Workspace {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    name: row.name,
    slug: row.slug,
    role,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function toConversation(row: Awaited<ReturnType<ConversationRepository["get"]>>): Conversation {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    workspaceId: row.workspaceId,
    ownerUserId: row.createdBy,
    title: row.title ?? "New conversation",
    visibility: row.visibility === "workspace" ? "workspace" : "private",
    status: row.status === "archived" ? "archived" : "active",
    archivedAt: row.archivedAt?.toISOString() ?? null,
    metadata: row.metadata as Conversation["metadata"],
  };
}

function toMessage(row: Awaited<ReturnType<ConversationRepository["appendUserMessage"]>>): Message {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    runId: row.runId ?? null,
    sequence: row.sequence,
    author: { type: "user", userId: row.authorId ?? "unknown" },
    parts: row.content as Message["parts"],
    status:
      row.status === "streaming"
        ? "streaming"
        : row.status === "redacted"
          ? "redacted"
          : row.status === "failed"
            ? "failed"
            : "complete",
  };
}

function toRun(row: Awaited<ReturnType<RunRepository["create"]>>): Run {
  const status: Run["status"] =
    row.status === "outcome_unknown"
      ? "unknown"
      : row.status === "cancelled"
        ? "cancelled"
        : row.status === "succeeded"
          ? "succeeded"
          : row.status === "failed"
            ? "failed"
            : row.status === "waiting_approval"
              ? "waiting_approval"
              : row.status === "running"
                ? "running"
                : "queued";
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    workspaceId: row.workspaceId,
    userId: row.requestedBy,
    conversationId: row.conversationId,
    goalId: null,
    status,
    trigger: "user",
    providerInstanceId: row.providerInstanceId ?? row.provider,
    configDigest: row.configDigest ?? null,
    memorySnapshotId: null,
    currentEventSequence: row.currentEventSequence,
    usage: null,
    error: row.error && typeof row.error === "object" ? (row.error as Run["error"]) : null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/**
 * The application service is the authenticated vertical slice shared by web,
 * native, and any future hosted API. Every instance is constructed with a
 * `ScopedDatabase`, so the caller's actor/workspace cannot be replaced by a
 * client-supplied ID during a mutation.
 */
export class OpenMuseApplication {
  readonly workspaces: WorkspaceRepository;
  readonly conversations: ConversationRepository;
  readonly tasks: TaskRepository;
  readonly runs: RunRepository;
  readonly approvals: ApprovalRepository;

  constructor(
    readonly scoped: ScopedDatabase,
    private readonly options: ApplicationOptions = {},
  ) {
    this.workspaces = new WorkspaceRepository(scoped);
    this.conversations = new ConversationRepository(scoped);
    this.tasks = new TaskRepository(scoped);
    this.runs = new RunRepository(scoped);
    this.approvals = new ApprovalRepository(scoped);
  }

  async getWorkspace(): Promise<Workspace> {
    try {
      const row = await this.workspaces.getWithMembership();
      return toWorkspace(row.workspace, row.role as Workspace["role"]);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async createWorkspace(input: unknown): Promise<Workspace> {
    const parsed = createWorkspaceInputSchema.safeParse(input);
    if (!parsed.success)
      throw new ApplicationError("Invalid workspace input", "invalid_request", 400);
    try {
      const created = await this.workspaces.create({
        id: this.scoped.scope.workspaceId,
        name: parsed.data.name,
        slug: slugify(parsed.data.name),
      });
      return toWorkspace(created, "owner");
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async updateWorkspace(input: unknown): Promise<Workspace> {
    const parsed = updateWorkspaceInputSchema.safeParse(input);
    if (!parsed.success)
      throw new ApplicationError("Invalid workspace input", "invalid_request", 400);
    try {
      const update: { name?: string; archived?: boolean } = {};
      if (parsed.data.name !== undefined) update.name = parsed.data.name;
      if (parsed.data.archived !== undefined) update.archived = parsed.data.archived;
      return toWorkspace(
        await this.workspaces.update(update),
        (await this.workspaces.getWithMembership()).role as Workspace["role"],
      );
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async createConversation(input: unknown): Promise<Conversation> {
    const parsed = createConversationInputSchema.safeParse(input);
    if (!parsed.success || parsed.data.workspaceId !== this.scoped.scope.workspaceId) {
      throw new ApplicationError("Invalid conversation input", "invalid_request", 400);
    }
    try {
      return toConversation(await this.conversations.create({ title: parsed.data.title }));
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async getConversation(id: string): Promise<Conversation> {
    try {
      return toConversation(await this.conversations.get(id));
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async listConversations(): Promise<Conversation[]> {
    try {
      return (await this.conversations.list()).map(toConversation);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async updateConversation(id: string, input: unknown): Promise<Conversation> {
    const parsed = updateConversationInputSchema.safeParse(input);
    if (!parsed.success)
      throw new ApplicationError("Invalid conversation input", "invalid_request", 400);
    try {
      const update: { title?: string; visibility?: string; archived?: boolean } = {};
      if (parsed.data.title !== undefined) update.title = parsed.data.title;
      if (parsed.data.visibility !== undefined) update.visibility = parsed.data.visibility;
      if (parsed.data.archived !== undefined) update.archived = parsed.data.archived;
      return toConversation(await this.conversations.update(id, update));
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async listMessages(conversationId: string): Promise<Message[]> {
    try {
      return (await this.conversations.listMessages(conversationId)).map(toMessage);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async getRun(runId: string): Promise<Run> {
    try {
      return toRun(await this.runs.get(runId));
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async cancelRun(runId: string, input: unknown): Promise<Run> {
    const parsed = cancelRunInputSchema.safeParse(input ?? {});
    if (!parsed.success)
      throw new ApplicationError("Invalid cancellation input", "invalid_request", 400);
    try {
      return toRun(await this.runs.cancel(runId, parsed.data.reason));
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async listRunEvents(
    runId: string,
    input: unknown,
  ): Promise<{ items: RunEvent[]; page: { nextCursor: string | null; hasMore: boolean } }> {
    const parsed = listEventsInputSchema.safeParse(input ?? {});
    if (!parsed.success) throw new ApplicationError("Invalid event query", "invalid_request", 400);
    try {
      const query: { cursor?: number; limit?: number } = { limit: parsed.data.limit };
      if (parsed.data.cursor !== undefined) query.cursor = Number(parsed.data.cursor);
      let result = await this.runs.listEvents(runId, query);
      const deadline = Date.now() + parsed.data.waitSeconds * 1000;
      while (result.items.length === 0 && parsed.data.waitSeconds > 0 && Date.now() < deadline) {
        const current = await this.runs.get(runId);
        if (["succeeded", "failed", "cancelled", "outcome_unknown"].includes(current.status)) break;
        await waitForEventPoll(Math.min(250, Math.max(deadline - Date.now(), 0)));
        result = await this.runs.listEvents(runId, query);
      }
      return {
        items: result.items.map((event) => ({
          id: `${event.runId}:${event.sequence}`,
          runId: event.runId,
          workspaceId: event.workspaceId,
          sequence: event.sequence,
          type: event.eventType as RunEvent["type"],
          occurredAt: event.createdAt.toISOString(),
          payload: event.payload as RunEvent["payload"],
        })),
        page: {
          nextCursor: result.items.at(-1)?.sequence.toString() ?? null,
          hasMore: result.hasMore,
        },
      };
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async sendMessage(input: unknown): Promise<SendMessageOutcome> {
    const parsed = sendMessageInputSchema.safeParse(input);
    if (!parsed.success)
      throw new ApplicationError("Invalid message input", "invalid_request", 400);
    assertAllowedUserParts(parsed.data);
    try {
      // Artifact ownership is checked before the message is persisted. The
      // query runs inside the same scoped transaction as the append in future
      // repository versions; for now it is a fail-closed preflight.
      await this.assertOwnedArtifacts(parsed.data);
      const provider = await this.resolveProviderSnapshot(parsed.data.providerInstanceId);
      const submission = await new ChatSubmissionRepository(this.scoped).submit({
        conversationId: parsed.data.conversationId,
        ...(parsed.data.clientMessageId ? { messageId: parsed.data.clientMessageId } : {}),
        content: parsed.data.parts,
        idempotencyKey: parsed.data.clientMessageId ?? randomUUID(),
        ...(provider ? { provider } : {}),
        ...(parsed.data.model ? { model: parsed.data.model } : {}),
      });
      return { message: toMessage(submission.message), run: toRun(submission.run) };
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  private async resolveProviderSnapshot(
    providerInstanceId?: string,
  ): Promise<ChatProviderSnapshot | undefined> {
    if (!this.options.providerCatalog) {
      if (providerInstanceId)
        throw new ApplicationError(
          "Provider configuration is unavailable",
          "provider_unavailable",
          409,
        );
      return undefined;
    }
    const instances = new ProviderInstanceRepository(this.scoped);
    const row = providerInstanceId
      ? await instances.get(providerInstanceId)
      : await instances.resolveDefault("model");
    if (!row) {
      if (providerInstanceId)
        throw new ApplicationError("Provider instance not found", "not_found", 404);
      throw new ApplicationError(
        "No default model provider is configured",
        "provider_unavailable",
        409,
      );
    }
    if (row.module !== "model" || row.status !== "available")
      throw new ApplicationError(
        "The selected model provider is unavailable",
        "provider_unavailable",
        409,
      );
    const catalog = this.options.providerCatalog.get(row.module, row.providerId);
    const bindings = row.credentialBindings.filter(isProviderBinding);
    if (bindings.length !== row.credentialBindings.length)
      throw new ApplicationError(
        "Provider credential bindings are incomplete",
        "provider_auth_required",
        409,
      );
    const configDigest = this.options.providerCatalog.digest({
      module: row.module,
      providerId: row.providerId,
      version: row.version,
      configVersion: row.configVersion,
      buildDigest: catalog.buildDigest,
      config: row.config,
      credentialBindings: bindings,
    });
    if (configDigest !== row.configDigest)
      throw new ApplicationError(
        "Provider configuration is stale and must be re-saved",
        "conflict",
        409,
      );
    return {
      providerInstanceId: row.id,
      providerId: row.providerId,
      module: row.module,
      version: row.version,
      buildDigest: catalog.buildDigest,
      configVersion: row.configVersion,
      config: row.config,
      credentialBindings: bindings,
      configDigest,
    };
  }

  private async assertOwnedArtifacts(input: SendMessageInput): Promise<void> {
    // The concrete artifact repository is intentionally not exposed from the
    // application package. A provider cannot cause a user-owned artifact to
    // cross workspace boundaries because this scoped query must find it first.
    // The current schema maps artifact IDs through the DB query in the next
    // transaction; text-only messages need no query.
    const artifactIds = input.parts.flatMap((part) =>
      part.type === "file" || part.type === "image" || part.type === "audio"
        ? [part.artifactId]
        : [],
    );
    if (artifactIds.length === 0) return;
    await this.scoped.run(async (tx) => {
      for (const artifactId of artifactIds) {
        const rows = await tx
          .select({ id: artifacts.id, createdBy: artifacts.createdBy })
          .from(artifacts)
          .where(eq(artifacts.id, artifactId))
          .limit(1);
        if (!rows[0] || rows[0].createdBy !== this.scoped.scope.actorId)
          throw new ApplicationError(
            "Referenced artifact is not available in this workspace.",
            "forbidden",
            403,
          );
      }
    });
  }
}

function waitForEventPoll(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 62);
  return `${slug || "workspace"}-${randomUUID().slice(0, 8)}`;
}

export { assertAllowedUserParts };
export { toConversation, toMessage, toRun, toWorkspace };
export * from "./conversation-task.js";
export * from "./task-types.js";
