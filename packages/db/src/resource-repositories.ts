import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbTransaction, ScopedDatabase } from "./context.js";
import {
  artifacts,
  connections,
  conversations,
  goals,
  memories,
  sharedSnapshotGrants,
  sharedSnapshots,
  users,
  workspaceMembers,
} from "./schema.js";
import { randomUUID } from "node:crypto";
import { RepositoryError, hashPayload } from "./repositories.js";

function notFound(resource: string): never {
  throw new RepositoryError(`${resource} was not found`, "not_found");
}

function forbidden(message: string): never {
  throw new RepositoryError(message, "forbidden");
}

function invalid(message: string): never {
  throw new RepositoryError(message, "invalid");
}

function requireOwner<T extends { createdBy: string }>(row: T | undefined, actorId: string): T {
  if (!row) notFound("Resource");
  if (row.createdBy !== actorId) forbidden("Only the creator can modify this resource");
  return row;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface GoalData {
  title: string;
  instructions: string;
  schedule:
    | {
        kind: "once";
        at: string;
      }
    | {
        kind: "interval";
        everySeconds: number;
        timezone: string;
      }
    | {
        kind: "cron";
        expression: string;
        timezone: string;
      }
    | null;
  connectionIds: string[];
  memoryIds: string[];
  approvalPolicyVersion: string;
}

function goalData(row: typeof goals.$inferSelect): GoalData {
  const config = row.config;
  return {
    title: row.title,
    instructions: row.description ?? "",
    schedule: config.schedule,
    connectionIds: config.connectionIds,
    memoryIds: config.memoryIds,
    approvalPolicyVersion: config.approvalPolicyVersion,
  };
}

function withGoalData(data: GoalData): typeof goals.$inferInsert.config {
  return {
    schedule: data.schedule,
    connectionIds: data.connectionIds,
    memoryIds: data.memoryIds,
    approvalPolicyVersion: data.approvalPolicyVersion,
  };
}

export class GoalRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  private get scope() {
    return this.scoped.scope;
  }

  async list(input: { limit: number; cursor?: number }) {
    const offset = input.cursor ?? 0;
    return this.scoped.run(async (tx) => {
      const rows = await tx
        .select()
        .from(goals)
        .where(
          and(
            eq(goals.workspaceId, this.scope.workspaceId),
            eq(goals.createdBy, this.scope.actorId),
          ),
        )
        .orderBy(desc(goals.updatedAt), desc(goals.id))
        .limit(input.limit + 1)
        .offset(offset);
      return {
        items: rows.slice(0, input.limit),
        hasMore: rows.length > input.limit,
      };
    });
  }

  async get(id: string) {
    return this.scoped.run(async (tx) => {
      const [row] = await tx
        .select()
        .from(goals)
        .where(
          and(
            eq(goals.id, id),
            eq(goals.workspaceId, this.scope.workspaceId),
            eq(goals.createdBy, this.scope.actorId),
          ),
        )
        .limit(1);
      return row ?? notFound("Goal");
    });
  }

  async create(input: { id?: string; data: GoalData; status?: string }) {
    return this.scoped.run(async (tx) => {
      await this.assertReferences(tx, input.data);
      const [row] = await tx
        .insert(goals)
        .values({
          id: input.id ?? randomUUID(),
          workspaceId: this.scope.workspaceId,
          createdBy: this.scope.actorId,
          title: input.data.title,
          description: input.data.instructions,
          status: input.status ?? "draft",
          revision: 1,
          config: withGoalData(input.data),
          nextRunAt: null,
        })
        .returning();
      if (!row) throw new RepositoryError("Goal could not be created", "conflict");
      return row;
    });
  }

  async update(id: string, input: { expectedRevision: number; data: Partial<GoalData> }) {
    return this.scoped.run(async (tx) => {
      const [current] = await tx
        .select()
        .from(goals)
        .where(
          and(
            eq(goals.id, id),
            eq(goals.workspaceId, this.scope.workspaceId),
            eq(goals.createdBy, this.scope.actorId),
          ),
        )
        .limit(1);
      requireOwner(current, this.scope.actorId);
      const currentRevision = current.revision;
      if (currentRevision !== input.expectedRevision)
        throw new RepositoryError("Goal was changed concurrently", "conflict");
      const currentData = goalData(current);
      const nextData: GoalData = {
        ...currentData,
        ...input.data,
        connectionIds: input.data.connectionIds ?? currentData.connectionIds,
        memoryIds: input.data.memoryIds ?? currentData.memoryIds,
      };
      await this.assertReferences(tx, nextData);
      const [updated] = await tx
        .update(goals)
        .set({
          title: nextData.title,
          description: nextData.instructions,
          revision: currentRevision + 1,
          config: withGoalData(nextData),
          nextRunAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(goals.id, id),
            eq(goals.workspaceId, this.scope.workspaceId),
            eq(goals.createdBy, this.scope.actorId),
            eq(goals.revision, currentRevision),
          ),
        )
        .returning();
      if (!updated) throw new RepositoryError("Goal was changed concurrently", "conflict");
      return updated;
    });
  }

  async changeStatus(id: string, status: string, expectedRevision: number) {
    return this.scoped.run(async (tx) => {
      const [current] = await tx
        .select()
        .from(goals)
        .where(
          and(
            eq(goals.id, id),
            eq(goals.workspaceId, this.scope.workspaceId),
            eq(goals.createdBy, this.scope.actorId),
          ),
        )
        .limit(1);
      requireOwner(current, this.scope.actorId);
      const currentRevision = current.revision;
      if (currentRevision !== expectedRevision)
        throw new RepositoryError("Goal was changed concurrently", "conflict");
      const [updated] = await tx
        .update(goals)
        .set({
          status,
          revision: currentRevision + 1,
          nextRunAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(goals.id, id),
            eq(goals.workspaceId, this.scope.workspaceId),
            eq(goals.createdBy, this.scope.actorId),
            eq(goals.revision, currentRevision),
          ),
        )
        .returning();
      if (!updated) throw new RepositoryError("Goal was changed concurrently", "conflict");
      return updated;
    });
  }

  private async assertReferences(tx: DbTransaction, data: GoalData): Promise<void> {
    const connectionIds = [...new Set(data.connectionIds)];
    if (connectionIds.length !== data.connectionIds.length)
      invalid("Goal connection references must be unique");
    if (connectionIds.length > 0) {
      const rows = await tx
        .select({ id: connections.id })
        .from(connections)
        .where(
          and(
            eq(connections.workspaceId, this.scope.workspaceId),
            eq(connections.userId, this.scope.actorId),
            inArray(connections.id, connectionIds),
          ),
        );
      if (rows.length !== connectionIds.length)
        forbidden("Goal connections must belong to the goal owner and workspace");
    }
    const memoryIds = [...new Set(data.memoryIds)];
    if (memoryIds.length !== data.memoryIds.length)
      invalid("Goal memory references must be unique");
    if (memoryIds.length > 0) {
      const rows = await tx
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.workspaceId, this.scope.workspaceId),
            eq(memories.createdBy, this.scope.actorId),
            isNull(memories.archivedAt),
            inArray(memories.id, memoryIds),
          ),
        );
      if (rows.length !== memoryIds.length)
        forbidden("Goal memories must belong to the goal owner and workspace");
    }
  }
}

export interface MemoryData {
  scope: string;
  conversationId?: string;
  title: string;
  source: string;
  sensitivity: string;
  version: number;
}

function memoryData(row: typeof memories.$inferSelect): MemoryData {
  const metadata = asRecord(row.metadata);
  return {
    scope: typeof metadata.scope === "string" ? metadata.scope : "workspace",
    ...(typeof metadata.conversationId === "string"
      ? { conversationId: metadata.conversationId }
      : {}),
    title: row.subject ?? "Memory",
    source: typeof metadata.source === "string" ? metadata.source : "user",
    sensitivity: typeof metadata.sensitivity === "string" ? metadata.sensitivity : "private",
    version: Number(metadata.version ?? 1),
  };
}

export class MemoryRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  private get scope() {
    return this.scoped.scope;
  }

  async list(scope?: string) {
    return this.scoped.run((tx) =>
      tx
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.workspaceId, this.scope.workspaceId),
            isNull(memories.archivedAt),
            ...(scope ? [sql`${memories.metadata}->>'scope' = ${scope}`] : []),
          ),
        )
        .orderBy(desc(memories.updatedAt)),
    );
  }

  async get(id: string) {
    return this.scoped.run(async (tx) => {
      const [row] = await tx
        .select()
        .from(memories)
        .where(and(eq(memories.id, id), eq(memories.workspaceId, this.scope.workspaceId)))
        .limit(1);
      return row ?? notFound("Memory");
    });
  }

  async create(input: { id?: string; data: Omit<MemoryData, "version">; content: string }) {
    return this.scoped.run(async (tx) => {
      const [row] = await tx
        .insert(memories)
        .values({
          id: input.id ?? randomUUID(),
          workspaceId: this.scope.workspaceId,
          createdBy: this.scope.actorId,
          subject: input.data.title,
          content: input.content,
          metadata: { ...input.data, version: 1 },
        })
        .returning();
      if (!row) throw new RepositoryError("Memory could not be created", "conflict");
      return row;
    });
  }

  async update(id: string, input: { expectedVersion: number; title?: string; content?: string }) {
    return this.scoped.run(async (tx) => {
      const [current] = await tx
        .select()
        .from(memories)
        .where(and(eq(memories.id, id), eq(memories.workspaceId, this.scope.workspaceId)))
        .limit(1);
      requireOwner(current, this.scope.actorId);
      const data = memoryData(current);
      if (data.version !== input.expectedVersion)
        throw new RepositoryError("Memory was changed concurrently", "conflict");
      const [updated] = await tx
        .update(memories)
        .set({
          ...(input.title === undefined ? {} : { subject: input.title }),
          ...(input.content === undefined ? {} : { content: input.content }),
          metadata: { ...asRecord(current.metadata), version: data.version + 1 },
          updatedAt: new Date(),
        })
        .where(and(eq(memories.id, id), eq(memories.workspaceId, this.scope.workspaceId)))
        .returning();
      return updated ?? notFound("Memory");
    });
  }

  async remove(id: string) {
    return this.scoped.run(async (tx) => {
      const [updated] = await tx
        .update(memories)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(memories.id, id),
            eq(memories.workspaceId, this.scope.workspaceId),
            eq(memories.createdBy, this.scope.actorId),
            isNull(memories.archivedAt),
          ),
        )
        .returning();
      return updated ?? notFound("Memory");
    });
  }
}

export class ArtifactRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  private get scope() {
    return this.scoped.scope;
  }

  async list(runId?: string) {
    return this.scoped.run((tx) =>
      tx
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.workspaceId, this.scope.workspaceId),
            ...(runId ? [eq(artifacts.runId, runId)] : []),
          ),
        )
        .orderBy(desc(artifacts.createdAt)),
    );
  }

  async get(id: string) {
    return this.scoped.run(async (tx) => {
      const [row] = await tx
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.id, id), eq(artifacts.workspaceId, this.scope.workspaceId)))
        .limit(1);
      return row ?? notFound("Artifact");
    });
  }

  async create(input: {
    id?: string;
    runId?: string;
    kind: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }) {
    return this.scoped.run(async (tx) => {
      const artifactId = input.id ?? randomUUID();
      const [row] = await tx
        .insert(artifacts)
        .values({
          id: artifactId,
          workspaceId: this.scope.workspaceId,
          createdBy: this.scope.actorId,
          ...(input.runId ? { runId: input.runId } : {}),
          kind: input.kind,
          name: input.name,
          contentType: input.mimeType,
          byteSize: input.sizeBytes,
          checksum: input.sha256,
          storageKey: `${this.scope.workspaceId}/${artifactId}`,
        })
        .returning();
      if (!row) throw new RepositoryError("Artifact could not be created", "conflict");
      return row;
    });
  }
}

export interface ShareRecord {
  id: string;
  snapshot: typeof sharedSnapshots.$inferSelect;
  grant: typeof sharedSnapshotGrants.$inferSelect;
  snapshotDigest: string;
}

export class ShareRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  private get scope() {
    return this.scoped.scope;
  }

  async create(input: {
    resourceType: "conversation" | "artifact";
    resourceId: string;
    recipientEmail?: string;
    userId?: string;
    expiresAt?: Date;
    payload: unknown;
  }) {
    return this.scoped.run(async (tx) => {
      if (input.resourceType === "conversation") {
        const [source] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, input.resourceId),
              eq(conversations.workspaceId, this.scope.workspaceId),
              eq(conversations.createdBy, this.scope.actorId),
            ),
          )
          .limit(1);
        if (!source) notFound("Conversation");
      } else {
        const [artifact] = await tx
          .select({ id: artifacts.id, createdBy: artifacts.createdBy })
          .from(artifacts)
          .where(
            and(
              eq(artifacts.id, input.resourceId),
              eq(artifacts.workspaceId, this.scope.workspaceId),
              eq(artifacts.createdBy, this.scope.actorId),
            ),
          )
          .limit(1);
        if (!artifact) notFound("Artifact");
      }
      if (input.expiresAt && input.expiresAt <= new Date())
        throw new RepositoryError("Share expiration must be in the future", "invalid");
      const email = input.recipientEmail?.trim().toLowerCase();
      const [recipient] = await tx
        .select({ id: users.id })
        .from(users)
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.userId, users.id),
            eq(workspaceMembers.workspaceId, this.scope.workspaceId),
            eq(workspaceMembers.status, "active"),
          ),
        )
        .where(email ? eq(users.email, email) : eq(users.id, input.userId ?? ""))
        .limit(1);
      if (!recipient) notFound("Recipient");
      const snapshotDigest = hashPayload(input.payload);
      const [snapshot] = await tx
        .insert(sharedSnapshots)
        .values({
          id: randomUUID(),
          workspaceId: this.scope.workspaceId,
          sourceType: input.resourceType,
          sourceId: input.resourceId,
          createdBy: this.scope.actorId,
          payload: {
            snapshotDigest,
            value: input.payload,
          },
        })
        .returning();
      if (!snapshot) throw new RepositoryError("Share snapshot could not be created", "conflict");
      const [grant] = await tx
        .insert(sharedSnapshotGrants)
        .values({
          snapshotId: snapshot.id,
          workspaceId: this.scope.workspaceId,
          userId: recipient.id,
          grantedBy: this.scope.actorId,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!grant) throw new RepositoryError("Share grant could not be created", "conflict");
      return {
        id: `${snapshot.id}:${grant.userId}`,
        snapshot,
        grant,
        snapshotDigest,
      } satisfies ShareRecord;
    });
  }

  async list(input: { resourceType?: string; resourceId?: string } = {}) {
    return this.scoped.run((tx) =>
      tx
        .select({ snapshot: sharedSnapshots, grant: sharedSnapshotGrants })
        .from(sharedSnapshots)
        .innerJoin(sharedSnapshotGrants, eq(sharedSnapshotGrants.snapshotId, sharedSnapshots.id))
        .where(
          and(
            eq(sharedSnapshots.workspaceId, this.scope.workspaceId),
            eq(sharedSnapshots.createdBy, this.scope.actorId),
            ...(input.resourceType ? [eq(sharedSnapshots.sourceType, input.resourceType)] : []),
            ...(input.resourceId ? [eq(sharedSnapshots.sourceId, input.resourceId)] : []),
          ),
        )
        .orderBy(desc(sharedSnapshots.createdAt)),
    );
  }

  async revoke(id: string) {
    const [snapshotId, userId] = id.split(":", 2);
    if (!snapshotId || !userId) throw new RepositoryError("Share ID is invalid", "invalid");
    return this.scoped.run(async (tx) => {
      const [updated] = await tx
        .update(sharedSnapshotGrants)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(sharedSnapshotGrants.snapshotId, snapshotId),
            eq(sharedSnapshotGrants.userId, userId),
            eq(sharedSnapshotGrants.workspaceId, this.scope.workspaceId),
          ),
        )
        .returning();
      return updated ?? notFound("Share");
    });
  }
}
