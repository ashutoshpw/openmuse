import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, exists, gt, inArray, isNull, lt, max, or, sql } from "drizzle-orm";
import type { OpenMuseDatabase } from "./client.js";
import type { DbTransaction, ScopedDatabase } from "./context.js";
import { appendEventInTransaction } from "./chat-repository.js";
import {
  approvals,
  auditEvents,
  conversationMembers,
  conversations,
  idempotencyRecords,
  messages,
  runEvents,
  runs,
  schedules,
  sharedSnapshotGrants,
  sharedSnapshots,
  taskLeases,
  tasks,
  users,
  workspaceInvites,
  workspaceMembers,
  workspaces,
} from "./schema.js";
import { RepositoryError } from "./repository-error.js";

export { RepositoryError } from "./repository-error.js";

function notFound(resource: string): never {
  throw new RepositoryError(`${resource} was not found`, "not_found");
}

function forbidden(message = "You do not have access to this resource"): never {
  throw new RepositoryError(message, "forbidden");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function requireOwner<T extends { createdBy: string }>(row: T | undefined, actorId: string): T {
  if (!row) notFound("Resource");
  if (row.createdBy !== actorId) forbidden("Only the creator can modify this resource");
  return row;
}

export class WorkspaceDirectoryRepository {
  constructor(private readonly db: OpenMuseDatabase) {}

  async list(actorId: string) {
    return this.db.execute<{
      id: string;
      name: string;
      slug: string;
      created_by: string;
      created_at: Date;
      updated_at: Date;
      role: string;
    }>(sql`select id, name, slug, created_by, created_at, updated_at, role
      from openmuse_list_actor_workspaces(${actorId})`);
  }
}

export type ResolvableResource =
  | "conversation"
  | "run"
  | "goal"
  | "memory"
  | "artifact"
  | "approval"
  | "provider_instance"
  | "share";

export async function resolveResourceWorkspace(
  db: OpenMuseDatabase,
  resourceType: ResolvableResource,
  resourceId: string,
  actorId: string,
): Promise<string | undefined> {
  const rows = await db.execute<{ workspace_id: string | null }>(
    sql`select openmuse_resolve_resource_workspace(${resourceType}, ${resourceId}, ${actorId}) as workspace_id`,
  );
  return rows[0]?.workspace_id ?? undefined;
}

export class WorkspaceRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  get scope() {
    return this.scoped.scope;
  }

  async create(input: {
    id?: string;
    name: string;
    slug: string;
    settings?: Record<string, unknown>;
  }) {
    const workspaceId = input.id ?? randomUUID();
    return this.scoped.run(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({
          id: workspaceId,
          name: input.name,
          slug: input.slug,
          createdBy: this.scope.actorId,
          settings: input.settings ?? {},
        })
        .returning();
      if (!workspace) throw new RepositoryError("Workspace could not be created", "conflict");
      await tx.insert(workspaceMembers).values({
        workspaceId,
        userId: this.scope.actorId,
        role: "owner",
        status: "active",
        invitedBy: this.scope.actorId,
      });
      return workspace;
    });
  }

  async get() {
    return this.scoped.run(async (tx) => {
      const [workspace] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, this.scope.workspaceId))
        .limit(1);
      return workspace ?? notFound("Workspace");
    });
  }

  async update(input: { name?: string; archived?: boolean }) {
    return this.scoped.run(async (tx) => {
      const [current] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, this.scope.workspaceId))
        .limit(1);
      if (!current) notFound("Workspace");
      await this.requireAdmin(tx);
      const [updated] = await tx
        .update(workspaces)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.archived === undefined
            ? {}
            : { archivedAt: input.archived ? new Date() : null }),
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, this.scope.workspaceId))
        .returning();
      return updated ?? notFound("Workspace");
    });
  }

  async getWithMembership() {
    return this.scoped.run(async (tx) => {
      const [row] = await tx
        .select({ workspace: workspaces, role: workspaceMembers.role })
        .from(workspaces)
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, workspaces.id),
            eq(workspaceMembers.userId, this.scope.actorId),
            eq(workspaceMembers.status, "active"),
          ),
        )
        .where(eq(workspaces.id, this.scope.workspaceId))
        .limit(1);
      return row ?? notFound("Workspace");
    });
  }

  async members() {
    return this.scoped.run((tx) =>
      tx
        .select({ member: workspaceMembers, user: users })
        .from(workspaceMembers)
        .innerJoin(users, eq(users.id, workspaceMembers.userId))
        .where(eq(workspaceMembers.workspaceId, this.scope.workspaceId))
        .orderBy(asc(users.email)),
    );
  }

  async invite(input: {
    id?: string;
    email: string;
    role?: "admin" | "member" | "viewer";
    tokenHash: string;
    expiresAt: Date;
  }) {
    return this.scoped.run(async (tx) => {
      await this.requireAdmin(tx);
      const [invite] = await tx
        .insert(workspaceInvites)
        .values({
          id: input.id ?? randomUUID(),
          workspaceId: this.scope.workspaceId,
          email: input.email.toLowerCase(),
          role: input.role ?? "member",
          tokenHash: input.tokenHash,
          invitedBy: this.scope.actorId,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!invite) throw new RepositoryError("Invite could not be created", "conflict");
      return invite;
    });
  }

  async addMember(input: { userId: string; role?: "admin" | "member" | "viewer" }) {
    return this.scoped.run(async (tx) => {
      await this.requireAdmin(tx);
      const [member] = await tx
        .insert(workspaceMembers)
        .values({
          workspaceId: this.scope.workspaceId,
          userId: input.userId,
          role: input.role ?? "member",
          status: "active",
          invitedBy: this.scope.actorId,
        })
        .returning();
      if (!member) throw new RepositoryError("Member could not be added", "conflict");
      return member;
    });
  }

  async removeMember(userId: string): Promise<void> {
    await this.scoped.run(async (tx) => {
      await this.requireAdmin(tx);
      const [member] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, this.scope.workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        )
        .limit(1);
      if (!member) return;
      if (member.role === "owner")
        throw new RepositoryError("The workspace owner cannot be removed", "invalid");
      await tx
        .update(workspaceMembers)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(
          and(
            eq(workspaceMembers.workspaceId, this.scope.workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        );
    });
  }

  private async requireAdmin(tx: DbTransaction): Promise<void> {
    const [member] = await tx
      .select({ role: workspaceMembers.role, status: workspaceMembers.status })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, this.scope.workspaceId),
          eq(workspaceMembers.userId, this.scope.actorId),
        ),
      )
      .limit(1);
    if (!member || member.status !== "active" || !["owner", "admin"].includes(member.role)) {
      forbidden("Workspace administrator access is required");
    }
  }
}

export class ConversationRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  private get scope() {
    return this.scoped.scope;
  }

  async create(input: { id?: string; title?: string | null }) {
    return this.scoped.run(async (tx) => {
      const conversationId = input.id ?? randomUUID();
      const [conversation] = await tx
        .insert(conversations)
        .values({
          id: conversationId,
          workspaceId: this.scope.workspaceId,
          createdBy: this.scope.actorId,
          title: input.title ?? null,
          visibility: "private",
        })
        .returning();
      if (!conversation) throw new RepositoryError("Conversation could not be created", "conflict");
      await tx.insert(conversationMembers).values({
        conversationId,
        userId: this.scope.actorId,
        permission: "owner",
        addedBy: this.scope.actorId,
      });
      return conversation;
    });
  }

  async list() {
    return this.scoped.run((tx) =>
      tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.workspaceId, this.scope.workspaceId),
            or(
              eq(conversations.createdBy, this.scope.actorId),
              exists(
                tx
                  .select({ one: sql`1` })
                  .from(conversationMembers)
                  .where(
                    and(
                      eq(conversationMembers.conversationId, conversations.id),
                      eq(conversationMembers.userId, this.scope.actorId),
                      eq(conversationMembers.permission, "owner"),
                    ),
                  ),
              ),
            ),
          ),
        )
        .orderBy(desc(conversations.updatedAt)),
    );
  }

  async get(conversationId: string) {
    return this.scoped.run((tx) => this.getReadable(tx, conversationId));
  }

  async update(
    conversationId: string,
    input: { title?: string; visibility?: string; archived?: boolean },
  ) {
    return this.scoped.run(async (tx) => {
      const conversation = await this.getReadable(tx, conversationId);
      requireOwner(conversation, this.scope.actorId);
      const [updated] = await tx
        .update(conversations)
        .set({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
          ...(input.archived === undefined
            ? {}
            : {
                status: input.archived ? "archived" : "active",
                archivedAt: input.archived ? new Date() : null,
              }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.workspaceId, this.scope.workspaceId),
          ),
        )
        .returning();
      return updated ?? notFound("Conversation");
    });
  }

  async listMessages(conversationId: string) {
    return this.scoped.run(async (tx) => {
      await this.getReadable(tx, conversationId);
      return tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.workspaceId, this.scope.workspaceId),
            eq(messages.conversationId, conversationId),
          ),
        )
        .orderBy(asc(messages.sequence));
    });
  }

  /** Only the creator can append; shared users only ever see snapshots. */
  async appendUserMessage(input: { conversationId: string; id?: string; content: unknown }) {
    return this.scoped.run(async (tx) => {
      const conversation = await this.getReadable(tx, input.conversationId);
      requireOwner(conversation, this.scope.actorId);
      // Lock the conversation row before calculating the next sequence. This
      // avoids duplicate sequence numbers under concurrent sends.
      await tx.execute(
        sql`select 1 from ${conversations} where ${conversations.id} = ${input.conversationId} for update`,
      );
      const [last] = await tx
        .select({ sequence: max(messages.sequence) })
        .from(messages)
        .where(
          and(
            eq(messages.workspaceId, this.scope.workspaceId),
            eq(messages.conversationId, input.conversationId),
          ),
        );
      const [message] = await tx
        .insert(messages)
        .values({
          id: input.id ?? randomUUID(),
          workspaceId: this.scope.workspaceId,
          conversationId: input.conversationId,
          authorId: this.scope.actorId,
          role: "user",
          status: "complete",
          sequence: (last?.sequence ?? 0) + 1,
          content: input.content,
        })
        .returning();
      if (!message) throw new RepositoryError("Message could not be created", "conflict");
      await tx
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, input.conversationId));
      return message;
    });
  }

  /** Server-authored assistant output. Callers must provide a run binding;
   * clients cannot reach this method through the user send-message route. */
  async appendAssistantMessage(input: { conversationId: string; runId: string; content: unknown }) {
    return this.scoped.run(async (tx) => {
      const conversation = await this.getReadable(tx, input.conversationId);
      requireOwner(conversation, this.scope.actorId);
      await tx.execute(
        sql`select 1 from ${conversations} where ${conversations.id} = ${input.conversationId} for update`,
      );
      const [last] = await tx
        .select({ sequence: max(messages.sequence) })
        .from(messages)
        .where(
          and(
            eq(messages.workspaceId, this.scope.workspaceId),
            eq(messages.conversationId, input.conversationId),
          ),
        );
      const [message] = await tx
        .insert(messages)
        .values({
          id: randomUUID(),
          workspaceId: this.scope.workspaceId,
          conversationId: input.conversationId,
          runId: input.runId,
          authorId: null,
          role: "assistant",
          status: "complete",
          sequence: (last?.sequence ?? 0) + 1,
          content: input.content,
        })
        .returning();
      if (!message) throw new RepositoryError("Assistant message could not be created", "conflict");
      await tx
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, input.conversationId));
      return message;
    });
  }

  async createSnapshot(input: { conversationId: string; id?: string }) {
    return this.scoped.run(async (tx) => {
      const conversation = await this.getReadable(tx, input.conversationId);
      requireOwner(conversation, this.scope.actorId);
      const snapshotMessages = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.workspaceId, this.scope.workspaceId),
            eq(messages.conversationId, input.conversationId),
          ),
        )
        .orderBy(asc(messages.sequence));
      const [snapshot] = await tx
        .insert(sharedSnapshots)
        .values({
          id: input.id ?? randomUUID(),
          workspaceId: this.scope.workspaceId,
          sourceType: "conversation",
          sourceId: input.conversationId,
          createdBy: this.scope.actorId,
          payload: { conversation, messages: snapshotMessages },
        })
        .returning();
      if (!snapshot) throw new RepositoryError("Snapshot could not be created", "conflict");
      return snapshot;
    });
  }

  async grantSnapshot(snapshotId: string, userId: string, expiresAt?: Date) {
    return this.scoped.run(async (tx) => {
      const [snapshot] = await tx
        .select()
        .from(sharedSnapshots)
        .where(
          and(
            eq(sharedSnapshots.id, snapshotId),
            eq(sharedSnapshots.workspaceId, this.scope.workspaceId),
          ),
        )
        .limit(1);
      if (!snapshot) notFound("Snapshot");
      requireOwner(snapshot, this.scope.actorId);
      const [target] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, this.scope.workspaceId),
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.status, "active"),
          ),
        )
        .limit(1);
      if (!target) forbidden("Snapshots may only be shared with active workspace members");
      const [grant] = await tx
        .insert(sharedSnapshotGrants)
        .values({
          snapshotId,
          workspaceId: this.scope.workspaceId,
          userId,
          grantedBy: this.scope.actorId,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: [sharedSnapshotGrants.snapshotId, sharedSnapshotGrants.userId],
          set: { grantedBy: this.scope.actorId, expiresAt, revokedAt: null },
        })
        .returning();
      return grant ?? new RepositoryError("Snapshot grant could not be created", "conflict");
    });
  }

  async revokeSnapshotGrant(snapshotId: string, userId: string): Promise<boolean> {
    return this.scoped.run(async (tx) => {
      const result = await tx
        .update(sharedSnapshotGrants)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(sharedSnapshotGrants.snapshotId, snapshotId),
            eq(sharedSnapshotGrants.workspaceId, this.scope.workspaceId),
            eq(sharedSnapshotGrants.userId, userId),
          ),
        );
      return result.count === 1;
    });
  }

  async getSnapshot(snapshotId: string) {
    return this.scoped.run(async (tx) => {
      const [snapshot] = await tx
        .select()
        .from(sharedSnapshots)
        .where(
          and(
            eq(sharedSnapshots.id, snapshotId),
            eq(sharedSnapshots.workspaceId, this.scope.workspaceId),
          ),
        )
        .limit(1);
      return snapshot ?? notFound("Snapshot");
    });
  }

  private async getReadable(tx: DbTransaction, conversationId: string) {
    const [conversation] = await tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.workspaceId, this.scope.workspaceId),
          or(
            eq(conversations.createdBy, this.scope.actorId),
            exists(
              tx
                .select({ one: sql`1` })
                .from(conversationMembers)
                .where(
                  and(
                    eq(conversationMembers.conversationId, conversations.id),
                    eq(conversationMembers.userId, this.scope.actorId),
                    eq(conversationMembers.permission, "owner"),
                  ),
                ),
            ),
          ),
        ),
      )
      .limit(1);
    return conversation ?? notFound("Conversation");
  }
}

export interface ClaimedTask {
  task: typeof tasks.$inferSelect;
  fenceToken: string;
}

export interface PendingTaskScope {
  workspaceId: string;
  actorId: string;
}

/**
 * The worker's only unscoped read. The SQL function is SECURITY DEFINER but
 * exposes only ready tenant/actor pairs and is executable only by the worker
 * database role. All task data is read and mutated through ScopedDatabase
 * after a pair is discovered.
 */
export class PendingTaskScopeRepository {
  constructor(private readonly db: OpenMuseDatabase) {}

  async discover(limit = 100): Promise<PendingTaskScope[]> {
    const rows = await this.db.execute<{ workspace_id: string; actor_id: string }>(
      sql`select workspace_id, actor_id from openmuse_discover_pending_task_scopes(${limit})`,
    );
    return rows.map((row) => ({ workspaceId: row.workspace_id, actorId: row.actor_id }));
  }
}

export class TaskRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  private get scope() {
    return this.scoped.scope;
  }

  async enqueue(input: {
    id?: string;
    runId?: string;
    kind: string;
    payload?: Record<string, unknown>;
    availableAt?: Date;
  }) {
    return this.scoped.run(async (tx) => {
      const [task] = await tx
        .insert(tasks)
        .values({
          id: input.id ?? randomUUID(),
          workspaceId: this.scope.workspaceId,
          ...(input.runId ? { runId: input.runId } : {}),
          requestedBy: this.scope.actorId,
          kind: input.kind,
          payload: input.payload ?? {},
          availableAt: input.availableAt ?? new Date(),
        })
        .returning();
      if (!task) throw new RepositoryError("Task could not be enqueued", "conflict");
      return task;
    });
  }

  /**
   * Claim is a single compare-and-swap transaction. A worker must present the
   * same tenant and actor scope that created the task; this prevents a worker
   * from turning a broad queue scan into a cross-user read.
   */
  async claim(workerId: string, leaseMs = 30_000): Promise<ClaimedTask | null> {
    return this.scoped.run(async (tx) => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + leaseMs);
      const fenceToken = randomUUID();
      const [task] = await tx
        .update(tasks)
        .set({
          status: "running",
          attempts: sql`${tasks.attempts} + 1`,
          leaseOwner: workerId,
          fenceToken,
          leaseExpiresAt: expiresAt,
          heartbeatAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(tasks.workspaceId, this.scope.workspaceId),
            eq(tasks.requestedBy, this.scope.actorId),
            or(
              and(eq(tasks.status, "queued"), lteOrNull(tasks.availableAt, now)),
              and(eq(tasks.status, "running"), ltOrNull(tasks.leaseExpiresAt, now)),
            ),
          ),
        )
        .returning();
      if (!task) return null;
      await tx
        .insert(taskLeases)
        .values({ taskId: task.id, workerId, fenceToken, expiresAt, heartbeatAt: now })
        .onConflictDoUpdate({
          target: taskLeases.taskId,
          set: { workerId, fenceToken, expiresAt, heartbeatAt: now },
        });
      return { task, fenceToken };
    });
  }

  async heartbeat(
    taskId: string,
    workerId: string,
    fenceToken: string,
    leaseMs = 30_000,
  ): Promise<boolean> {
    return this.scoped.run(async (tx) => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + leaseMs);
      const result = await tx
        .update(tasks)
        .set({ leaseExpiresAt: expiresAt, heartbeatAt: now, updatedAt: now })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, this.scope.workspaceId),
            eq(tasks.requestedBy, this.scope.actorId),
            eq(tasks.status, "running"),
            eq(tasks.leaseOwner, workerId),
            eq(tasks.fenceToken, fenceToken),
            or(
              isNull(tasks.runId),
              sql`not exists (
                select 1 from runs r
                where r.id = ${tasks.runId}
                  and r.status = 'cancelled'
              )`,
            ),
          ),
        );
      if (result.count !== 1) return false;
      await tx
        .update(taskLeases)
        .set({ expiresAt, heartbeatAt: now })
        .where(
          and(
            eq(taskLeases.taskId, taskId),
            eq(taskLeases.workerId, workerId),
            eq(taskLeases.fenceToken, fenceToken),
          ),
        );
      return true;
    });
  }

  /**
   * Poll the persisted task/run state without broadening the tenant scope.
   * This lets an active provider receive an abort signal when a user cancels
   * the run, even if the task lease itself is still valid.
   */
  async cancellationState(taskId: string): Promise<"active" | "cancelled" | "missing"> {
    return this.scoped.run(async (tx) => {
      const [row] = await tx
        .select({ taskStatus: tasks.status, runStatus: runs.status })
        .from(tasks)
        .leftJoin(runs, eq(runs.id, tasks.runId))
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, this.scope.workspaceId),
            eq(tasks.requestedBy, this.scope.actorId),
          ),
        )
        .limit(1);
      if (!row) return "missing";
      return row.taskStatus === "cancelled" || row.runStatus === "cancelled"
        ? "cancelled"
        : "active";
    });
  }

  async checkpoint(
    taskId: string,
    workerId: string,
    fenceToken: string,
    checkpoint: Record<string, unknown>,
  ): Promise<boolean> {
    return this.scoped.run(async (tx) => {
      const result = await tx
        .update(tasks)
        .set({ checkpoint, updatedAt: new Date() })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, this.scope.workspaceId),
            eq(tasks.requestedBy, this.scope.actorId),
            eq(tasks.status, "running"),
            eq(tasks.leaseOwner, workerId),
            eq(tasks.fenceToken, fenceToken),
          ),
        );
      return result.count === 1;
    });
  }

  async complete(
    taskId: string,
    workerId: string,
    fenceToken: string,
    status: "succeeded" | "failed" | "cancelled" | "outcome_unknown" = "succeeded",
    error?: Record<string, unknown>,
  ): Promise<boolean> {
    return this.scoped.run(async (tx) => {
      const result = await tx
        .update(tasks)
        .set({
          status,
          lastError: error,
          leaseOwner: null,
          fenceToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, this.scope.workspaceId),
            eq(tasks.requestedBy, this.scope.actorId),
            eq(tasks.status, "running"),
            eq(tasks.leaseOwner, workerId),
            eq(tasks.fenceToken, fenceToken),
          ),
        );
      if (result.count !== 1) return false;
      await tx
        .delete(taskLeases)
        .where(
          and(
            eq(taskLeases.taskId, taskId),
            eq(taskLeases.workerId, workerId),
            eq(taskLeases.fenceToken, fenceToken),
          ),
        );
      return true;
    });
  }

  async waitForApproval(
    taskId: string,
    workerId: string,
    fenceToken: string,
    checkpoint?: Record<string, unknown>,
  ): Promise<boolean> {
    return this.scoped.run(async (tx) => {
      const result = await tx
        .update(tasks)
        .set({
          status: "waiting_approval",
          checkpoint,
          leaseOwner: null,
          fenceToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.id, taskId),
            eq(tasks.workspaceId, this.scope.workspaceId),
            eq(tasks.requestedBy, this.scope.actorId),
            eq(tasks.status, "running"),
            eq(tasks.leaseOwner, workerId),
            eq(tasks.fenceToken, fenceToken),
          ),
        );
      if (result.count !== 1) return false;
      await tx
        .delete(taskLeases)
        .where(
          and(
            eq(taskLeases.taskId, taskId),
            eq(taskLeases.workerId, workerId),
            eq(taskLeases.fenceToken, fenceToken),
          ),
        );
      return true;
    });
  }

  /** Provider-side ambiguity is terminal until an operator resolves it. */
  async markOutcomeUnknown(
    taskId: string,
    workerId: string,
    fenceToken: string,
    error: Record<string, unknown>,
  ): Promise<boolean> {
    return this.complete(taskId, workerId, fenceToken, "outcome_unknown", error);
  }
}

function lteOrNull(column: unknown, value: Date) {
  return or(lt(column as never, value), isNull(column as never));
}

function ltOrNull(column: unknown, value: Date) {
  return or(lt(column as never, value), isNull(column as never));
}

export class ApprovalRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  private get scope() {
    return this.scoped.scope;
  }

  async create(input: {
    id?: string;
    runId?: string;
    actionType: string;
    risk?: string;
    payload: unknown;
    expiresAt: Date;
    toolCallId?: string;
    connectionId?: string;
    policyVersion?: string;
    target?: Record<string, unknown>;
  }) {
    return this.scoped.run(async (tx) => {
      const nonce = randomUUID();
      const payloadHash = hashPayload(input.payload);
      const digest = hashPayload({
        actionType: input.actionType,
        payloadHash,
        nonce,
        policyVersion: input.policyVersion ?? "1",
      });
      const [approval] = await tx
        .insert(approvals)
        .values({
          id: input.id ?? randomUUID(),
          workspaceId: this.scope.workspaceId,
          runId: input.runId,
          requestedBy: this.scope.actorId,
          actionType: input.actionType,
          risk: input.risk ?? "external_side_effect",
          payload: input.payload,
          payloadHash,
          nonce,
          digest,
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
          policyVersion: input.policyVersion ?? "1",
          ...(input.connectionId ? { connectionId: input.connectionId } : {}),
          target: input.target ?? {},
          status: "pending",
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!approval) throw new RepositoryError("Approval could not be created", "conflict");
      return approval;
    });
  }

  async decide(id: string, decision: "approved" | "denied", expectedDigest?: string) {
    return this.scoped.run(async (tx) => {
      const [current] = await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, id), eq(approvals.workspaceId, this.scope.workspaceId)))
        .limit(1);
      if (!current) notFound("Approval");
      if (current.requestedBy === this.scope.actorId)
        forbidden("A requester cannot approve their own side effect");
      if (expectedDigest && current.digest !== expectedDigest) {
        throw new RepositoryError("Approval digest does not match", "invalid");
      }
      if (current.status !== "pending" || current.expiresAt <= new Date()) {
        throw new RepositoryError(
          "Approval is no longer actionable",
          current.expiresAt <= new Date() ? "expired" : "conflict",
        );
      }
      const [updated] = await tx
        .update(approvals)
        .set({
          status: decision,
          approvedBy: this.scope.actorId,
          decidedAt: new Date(),
          version: current.version + 1,
        })
        .where(
          and(
            eq(approvals.id, id),
            eq(approvals.status, "pending"),
            eq(approvals.version, current.version),
          ),
        )
        .returning();
      if (!updated) throw new RepositoryError("Approval was changed concurrently", "conflict");
      return updated;
    });
  }

  async claimApprovedExecution(id: string) {
    return this.scoped.run(async (tx) => {
      const [updated] = await tx
        .update(approvals)
        .set({ status: "executing", version: sql`${approvals.version} + 1` })
        .where(
          and(
            eq(approvals.id, id),
            eq(approvals.workspaceId, this.scope.workspaceId),
            eq(approvals.status, "approved"),
            gt(approvals.expiresAt, new Date()),
          ),
        )
        .returning();
      return updated ?? null;
    });
  }

  async finish(id: string, status: "succeeded" | "failed" | "outcome_unknown") {
    return this.scoped.run(async (tx) => {
      const [updated] = await tx
        .update(approvals)
        .set({ status, version: sql`${approvals.version} + 1`, decidedAt: new Date() })
        .where(
          and(
            eq(approvals.id, id),
            eq(approvals.workspaceId, this.scope.workspaceId),
            eq(approvals.status, "executing"),
          ),
        )
        .returning();
      return updated ?? null;
    });
  }
}

export class RunRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  private get scope() {
    return this.scoped.scope;
  }

  async create(input: {
    id?: string;
    conversationId: string;
    idempotencyKey?: string;
    provider?: string;
  }) {
    return this.scoped.run(async (tx) => {
      const [run] = await tx
        .insert(runs)
        .values({
          id: input.id ?? randomUUID(),
          workspaceId: this.scope.workspaceId,
          conversationId: input.conversationId,
          requestedBy: this.scope.actorId,
          status: "queued",
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(input.provider ? { provider: input.provider } : {}),
        })
        .onConflictDoNothing()
        .returning();
      if (run) return run;
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select()
          .from(runs)
          .where(
            and(
              eq(runs.workspaceId, this.scope.workspaceId),
              eq(runs.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (existing) return existing;
      }
      throw new RepositoryError("Run could not be created", "conflict");
    });
  }

  async appendEvent(runId: string, eventType: string, payload: unknown) {
    return this.scoped.run(async (tx) => {
      const [run] = await tx
        .select({
          id: runs.id,
          currentEventSequence: runs.currentEventSequence,
          status: runs.status,
        })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.workspaceId, this.scope.workspaceId)))
        .for("update")
        .limit(1);
      if (!run) notFound("Run");
      assertRunEventAllowed(run.status, eventType);
      const sequence = run.currentEventSequence + 1;
      const [event] = await tx
        .insert(runEvents)
        .values({
          runId,
          workspaceId: this.scope.workspaceId,
          sequence,
          eventType,
          payload,
        })
        .returning();
      if (!event) throw new RepositoryError("Run event could not be persisted", "conflict");
      await tx
        .update(runs)
        .set({ currentEventSequence: sequence, updatedAt: new Date() })
        .where(and(eq(runs.id, runId), eq(runs.workspaceId, this.scope.workspaceId)));
      return event;
    });
  }

  async get(runId: string) {
    return this.scoped.run(async (tx) => {
      const [run] = await tx
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.workspaceId, this.scope.workspaceId),
            eq(runs.requestedBy, this.scope.actorId),
          ),
        )
        .limit(1);
      return run ?? notFound("Run");
    });
  }

  async listEvents(runId: string, input: { cursor?: number; limit?: number } = {}) {
    return this.scoped.run(async (tx) => {
      const run = await this.getInTransaction(tx, runId);
      void run;
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
      const rows = await tx
        .select()
        .from(runEvents)
        .where(
          and(
            eq(runEvents.runId, runId),
            eq(runEvents.workspaceId, this.scope.workspaceId),
            ...(input.cursor === undefined ? [] : [gt(runEvents.sequence, input.cursor)]),
          ),
        )
        .orderBy(asc(runEvents.sequence))
        .limit(limit + 1);
      return { items: rows.slice(0, limit), hasMore: rows.length > limit };
    });
  }

  async cancel(runId: string, reason?: string) {
    return this.scoped.run(async (tx) => {
      const [run] = await tx
        .update(runs)
        .set({
          status: "cancelled",
          error: {
            code: "cancelled",
            message: reason?.trim() || "Run cancelled by the requester.",
            retryable: false,
            uncertain: false,
          },
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.workspaceId, this.scope.workspaceId),
            eq(runs.requestedBy, this.scope.actorId),
            or(
              eq(runs.status, "queued"),
              eq(runs.status, "running"),
              eq(runs.status, "waiting_approval"),
            ),
          ),
        )
        .returning();
      if (!run) return this.getInTransaction(tx, runId);
      await appendEventInTransaction(tx, runId, this.scope.workspaceId, "run.cancelled", {
        message:
          run.error && typeof run.error === "object"
            ? run.error.message
            : "Run cancelled by the requester.",
      });
      await tx
        .update(tasks)
        .set({
          status: "cancelled",
          lastError: run.error,
          leaseOwner: null,
          fenceToken: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tasks.runId, runId),
            eq(tasks.requestedBy, this.scope.actorId),
            or(
              eq(tasks.status, "queued"),
              eq(tasks.status, "running"),
              eq(tasks.status, "waiting_approval"),
            ),
          ),
        );
      const runTasks = await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.runId, runId), eq(tasks.requestedBy, this.scope.actorId)));
      if (runTasks.length > 0)
        await tx.delete(taskLeases).where(
          inArray(
            taskLeases.taskId,
            runTasks.map((task) => task.id),
          ),
        );
      return run;
    });
  }

  async updateStatus(
    runId: string,
    status:
      | "running"
      | "waiting_approval"
      | "succeeded"
      | "failed"
      | "cancelled"
      | "outcome_unknown",
    checkpoint?: Record<string, unknown>,
    error?: Record<string, unknown>,
  ) {
    return this.scoped.run(async (tx) => {
      const persistedError =
        error === undefined
          ? undefined
          : {
              ...error,
              retryable: typeof error.retryable === "boolean" ? error.retryable : false,
              uncertain:
                typeof error.uncertain === "boolean"
                  ? error.uncertain
                  : status === "outcome_unknown",
            };
      const [run] = await tx
        .update(runs)
        .set({
          status,
          checkpoint,
          error: persistedError,
          startedAt: status === "running" ? new Date() : undefined,
          finishedAt: ["succeeded", "failed", "cancelled", "outcome_unknown"].includes(status)
            ? new Date()
            : undefined,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(runs.id, runId),
            eq(runs.workspaceId, this.scope.workspaceId),
            eq(runs.requestedBy, this.scope.actorId),
            or(
              eq(runs.status, "queued"),
              eq(runs.status, "running"),
              eq(runs.status, "waiting_approval"),
            ),
          ),
        )
        .returning();
      return run ?? null;
    });
  }

  private async getInTransaction(tx: DbTransaction, runId: string) {
    const [run] = await tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.workspaceId, this.scope.workspaceId),
          eq(runs.requestedBy, this.scope.actorId),
        ),
      )
      .limit(1);
    return run ?? notFound("Run");
  }
}

/**
 * Events are part of the run state machine. In particular, a stale worker
 * must not append progress or a second terminal result after cancellation.
 * Terminal events are emitted only after their matching terminal status has
 * been persisted by the same actor that owns the run.
 */
function assertRunEventAllowed(status: string, eventType: string): void {
  if (status === "queued") {
    if (eventType === "run.created") return;
  } else if (status === "running") {
    if (
      eventType === "run.started" ||
      eventType === "run.progress" ||
      eventType === "message.created" ||
      eventType === "message.delta" ||
      eventType === "tool.call"
    )
      return;
  } else if (status === "waiting_approval") {
    if (eventType === "run.waiting_approval") return;
  } else if (status === "succeeded") {
    if (eventType === "message.completed" || eventType === "run.completed") return;
  } else if (status === "failed" || status === "outcome_unknown") {
    if (eventType === "run.failed") return;
  } else if (status === "cancelled") {
    if (eventType === "run.cancelled") return;
  }
  throw new RepositoryError(`Event ${eventType} is not valid for run status ${status}`, "conflict");
}

export async function recordAudit(
  scoped: ScopedDatabase,
  input: {
    action: string;
    resourceType: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await scoped.run(async (tx) => {
    await tx.insert(auditEvents).values({
      id: randomUUID(),
      workspaceId: scoped.scope.workspaceId,
      actorId: scoped.scope.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: input.metadata ?? {},
    });
  });
}

export async function putIdempotencyRecord(
  scoped: ScopedDatabase,
  input: {
    key: string;
    requestHash: string;
    responseStatus?: number;
    responseBody?: unknown;
    expiresAt: Date;
  },
) {
  return scoped.run(async (tx) => {
    const [record] = await tx
      .insert(idempotencyRecords)
      .values({
        key: input.key,
        workspaceId: scoped.scope.workspaceId,
        actorId: scoped.scope.actorId,
        requestHash: input.requestHash,
        responseStatus: input.responseStatus,
        responseBody: input.responseBody,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          idempotencyRecords.workspaceId,
          idempotencyRecords.actorId,
          idempotencyRecords.key,
        ],
        set: {
          requestHash: input.requestHash,
          responseStatus: input.responseStatus,
          responseBody: input.responseBody,
          expiresAt: input.expiresAt,
        },
      })
      .returning();
    return record;
  });
}

export async function listDueSchedules(scoped: ScopedDatabase, now = new Date()) {
  return scoped.run((tx) =>
    tx
      .select()
      .from(schedules)
      .where(
        and(
          eq(schedules.workspaceId, scoped.scope.workspaceId),
          eq(schedules.enabled, true),
          lt(schedules.nextRunAt, now),
        ),
      )
      .orderBy(asc(schedules.nextRunAt)),
  );
}
