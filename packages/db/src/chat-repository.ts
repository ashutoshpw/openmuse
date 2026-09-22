import { randomUUID } from "node:crypto";
import { and, asc, eq, exists, max, or, sql } from "drizzle-orm";
import type { DbTransaction, ScopedDatabase } from "./context.js";
import { hashPayload, RepositoryError } from "./repositories.js";
import {
  conversationMembers,
  conversations,
  idempotencyRecords,
  messages,
  runEvents,
  runs,
  tasks,
} from "./schema.js";
import type { ProviderBinding } from "./provider-repositories.js";

export interface ChatProviderSnapshot {
  providerInstanceId: string;
  providerId: string;
  module: string;
  version: string;
  buildDigest: string;
  configVersion: string;
  config: Record<string, unknown>;
  credentialBindings: ProviderBinding[];
  configDigest: string;
}

export class ChatSubmissionRepository {
  constructor(private readonly scoped: ScopedDatabase) {}

  private get scope() {
    return this.scoped.scope;
  }

  async submit(input: {
    conversationId: string;
    messageId?: string;
    content: unknown;
    idempotencyKey: string;
    provider?: ChatProviderSnapshot;
    model?: string;
  }) {
    return this.scoped.run(async (tx) => {
      const requestHash = hashPayload({
        conversationId: input.conversationId,
        content: input.content,
        model: input.model ?? null,
        provider: input.provider ?? null,
      });
      if (input.messageId) {
        const [claimed] = await tx
          .insert(idempotencyRecords)
          .values({
            key: input.messageId,
            workspaceId: this.scope.workspaceId,
            actorId: this.scope.actorId,
            requestHash,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          })
          .onConflictDoNothing({
            target: [
              idempotencyRecords.workspaceId,
              idempotencyRecords.actorId,
              idempotencyRecords.key,
            ],
          })
          .returning({ key: idempotencyRecords.key });
        if (!claimed) {
          const [record] = await tx
            .select({ requestHash: idempotencyRecords.requestHash })
            .from(idempotencyRecords)
            .where(
              and(
                eq(idempotencyRecords.workspaceId, this.scope.workspaceId),
                eq(idempotencyRecords.actorId, this.scope.actorId),
                eq(idempotencyRecords.key, input.messageId),
              ),
            )
            .for("update")
            .limit(1);
          if (!record || record.requestHash !== requestHash)
            throw new RepositoryError(
              "Idempotency key was reused with different content",
              "conflict",
            );
          const existing = await this.findExisting(tx, input.messageId, input.conversationId);
          if (existing) return existing;
          throw new RepositoryError("Message submission is incomplete", "conflict");
        }
      }
      const [conversation] = await tx
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, input.conversationId),
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
      if (!conversation) throw new RepositoryError("Conversation was not found", "not_found");
      if (conversation.createdBy !== this.scope.actorId)
        throw new RepositoryError("Only the conversation owner can send messages", "forbidden");
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
      const messageId = input.messageId ?? randomUUID();
      const [message] = await tx
        .insert(messages)
        .values({
          id: messageId,
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
      const runId = randomUUID();
      const [run] = await tx
        .insert(runs)
        .values({
          id: runId,
          workspaceId: this.scope.workspaceId,
          conversationId: input.conversationId,
          requestedBy: this.scope.actorId,
          status: "queued",
          provider: input.provider?.providerId,
          providerInstanceId: input.provider?.providerInstanceId,
          providerId: input.provider?.providerId,
          providerModule: input.provider?.module,
          providerVersion: input.provider?.version,
          providerBuildDigest: input.provider?.buildDigest,
          providerConfigVersion: input.provider?.configVersion,
          providerConfig: input.provider?.config,
          providerCredentialBindings: input.provider?.credentialBindings,
          configDigest: input.provider?.configDigest,
          idempotencyKey: input.idempotencyKey,
          currentEventSequence: 0,
        })
        .returning();
      if (!run) throw new RepositoryError("Run could not be created", "conflict");
      await tx
        .update(messages)
        .set({ runId, updatedAt: new Date() })
        .where(eq(messages.id, message.id));
      await appendEventInTransaction(tx, runId, this.scope.workspaceId, "run.created", {
        runId,
        providerInstanceId: input.provider?.providerInstanceId ?? null,
        configDigest: input.provider?.configDigest ?? null,
      });
      const payload: Record<string, unknown> = {
        runId,
        conversationId: input.conversationId,
        messageId: message.id,
        ...(input.provider?.providerInstanceId
          ? { providerInstanceId: input.provider.providerInstanceId }
          : {}),
        ...(input.provider?.providerId ? { providerId: input.provider.providerId } : {}),
        ...(input.model ? { model: input.model } : {}),
      };
      const [task] = await tx
        .insert(tasks)
        .values({
          id: randomUUID(),
          workspaceId: this.scope.workspaceId,
          runId,
          requestedBy: this.scope.actorId,
          kind: "conversation.run",
          payload,
          availableAt: new Date(),
        })
        .returning();
      if (!task) throw new RepositoryError("Task could not be enqueued", "conflict");
      await tx
        .update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, input.conversationId));
      return { message: { ...message, runId }, run, task };
    });
  }

  private async findExisting(tx: DbTransaction, messageId: string, conversationId: string) {
    const [message] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, messageId),
          eq(messages.workspaceId, this.scope.workspaceId),
          eq(messages.conversationId, conversationId),
          eq(messages.authorId, this.scope.actorId),
          eq(messages.role, "user"),
        ),
      )
      .limit(1);
    if (!message) return null;
    if (!message.runId) throw new RepositoryError("Message submission is incomplete", "conflict");
    const [run] = await tx
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.id, message.runId),
          eq(runs.workspaceId, this.scope.workspaceId),
          eq(runs.requestedBy, this.scope.actorId),
        ),
      )
      .limit(1);
    if (!run) throw new RepositoryError("Message submission run is missing", "conflict");
    const [task] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.runId, run.id),
          eq(tasks.workspaceId, this.scope.workspaceId),
          eq(tasks.requestedBy, this.scope.actorId),
        ),
      )
      .orderBy(asc(tasks.createdAt))
      .limit(1);
    if (!task) throw new RepositoryError("Message submission task is missing", "conflict");
    return { message, run, task };
  }
}

export async function appendEventInTransaction(
  tx: DbTransaction,
  runId: string,
  workspaceId: string,
  eventType: string,
  payload: unknown,
) {
  const [run] = await tx
    .select({ currentEventSequence: runs.currentEventSequence, status: runs.status })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.workspaceId, workspaceId)))
    .for("update")
    .limit(1);
  if (!run) throw new RepositoryError("Run was not found", "not_found");
  assertChatEventAllowed(run.status, eventType);
  const sequence = run.currentEventSequence + 1;
  const [event] = await tx
    .insert(runEvents)
    .values({ runId, workspaceId, sequence, eventType, payload })
    .returning();
  if (!event) throw new RepositoryError("Run event could not be persisted", "conflict");
  await tx
    .update(runs)
    .set({ currentEventSequence: sequence, updatedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.workspaceId, workspaceId)));
  return event;
}

function assertChatEventAllowed(status: string, eventType: string): void {
  if (status === "queued" && eventType === "run.created") return;
  if (
    status === "running" &&
    ["run.started", "run.progress", "message.created", "message.delta", "tool.call"].includes(
      eventType,
    )
  )
    return;
  if (status === "waiting_approval" && eventType === "run.waiting_approval") return;
  if (status === "succeeded" && ["message.completed", "run.completed"].includes(eventType)) return;
  if ((status === "failed" || status === "outcome_unknown") && eventType === "run.failed") return;
  if (status === "cancelled" && eventType === "run.cancelled") return;
  throw new RepositoryError(`Event ${eventType} is not valid for run status ${status}`, "conflict");
}
