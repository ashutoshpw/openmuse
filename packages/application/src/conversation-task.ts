import { randomUUID } from "node:crypto";
import type { JsonObject, MessagePart } from "@openmuse/contracts";
import type {
  ModelClient,
  ModelEvent,
  ModelGenerateRequest,
  ModelMessage,
  ModelToolDefinition,
} from "@openmuse/provider-contracts";
import { ProviderOperationError } from "@openmuse/provider-contracts";
import {
  ApprovalRepository,
  ConversationRepository,
  RepositoryError,
  RunRepository,
  ScopedDatabase,
  type OpenMuseDatabase,
  type Task,
} from "@openmuse/db";
import type {
  DurableTaskHandler,
  PersistedTaskCancellation,
  TaskExecutionContext,
  TaskOutcome,
} from "./task-types.js";

export interface ConversationTaskPayload {
  runId: string;
  conversationId: string;
  messageId: string;
  providerInstanceId?: string;
  providerId?: string;
  model?: string;
  connectionId?: string;
  tools?: readonly ModelToolDefinition[];
}

export interface ResolvedModel {
  client: ModelClient;
  providerInstanceId: string;
  providerId: string;
  configDigest?: string;
  model?: string;
}

export interface ConversationTaskOptions {
  db: OpenMuseDatabase;
  resolveModel(
    payload: ConversationTaskPayload,
    context: TaskExecutionContext,
    task: Task,
  ): Promise<ResolvedModel>;
  now?: () => Date;
}

/**
 * Durable model execution. Provider events are persisted before the task can
 * complete, so a reconnect can replay ordered run events. Tool calls stop at a
 * fresh approval record; no standing approval or automatic provider replay is
 * possible.
 */
export class ConversationTaskHandler implements DurableTaskHandler {
  readonly kind = "conversation.run";

  constructor(private readonly options: ConversationTaskOptions) {}

  async execute(task: Task, context: TaskExecutionContext): Promise<TaskOutcome> {
    const payload = parsePayload(task.payload);
    const scoped = new ScopedDatabase(this.options.db, {
      workspaceId: task.workspaceId,
      actorId: task.requestedBy,
    });
    const conversations = new ConversationRepository(scoped);
    const runs = new RunRepository(scoped);
    const approvals = new ApprovalRepository(scoped);
    const started = await runs.updateStatus(payload.runId, "running");
    if (!started) {
      const current = await getRunIfPresent(runs, payload.runId);
      if (current?.status === "cancelled") return cancelledOutcome(current.error);
      throw new Error("The conversation run could not be started");
    }
    try {
      await runs.appendEvent(payload.runId, "run.started", {
        runId: payload.runId,
        workspaceId: task.workspaceId,
      });
    } catch (error) {
      const current = await getRunIfPresent(runs, payload.runId);
      if (current?.status === "cancelled") return cancelledOutcome(current.error);
      throw error;
    }

    let resolved: ResolvedModel | undefined;
    const assistantParts: MessagePart[] = [];
    let usage: Record<string, number> | undefined;
    try {
      const sourceMessages = await conversations.listMessages(payload.conversationId);
      const request: ModelGenerateRequest = {
        messages: sourceMessages.map(toModelMessage),
        ...(payload.model === undefined ? {} : { model: payload.model }),
        ...(payload.tools === undefined ? {} : { tools: [...payload.tools] }),
      };
      resolved = await this.options.resolveModel(payload, context, task);
      const operationContext = {
        signal: context.signal,
        operationId: randomUUID(),
        idempotencyKey: `${payload.runId}:model`,
      };
      for await (const event of resolved.client.generate(request, operationContext)) {
        if (context.signal.aborted) throw context.signal.reason ?? new Error("Task cancelled");
        await this.persistEvent(runs, payload.runId, event);
        if (event.type === "text_delta") {
          const previous = assistantParts.at(-1);
          if (previous?.type === "text") previous.text += event.text;
          else assistantParts.push({ type: "text", text: event.text });
        } else if (event.type === "usage") {
          usage = {
            ...(event.inputTokens === undefined ? {} : { inputTokens: event.inputTokens }),
            ...(event.outputTokens === undefined ? {} : { outputTokens: event.outputTokens }),
            ...(event.costMinorUnits === undefined ? {} : { costMinorUnits: event.costMinorUnits }),
          };
        } else if (event.type === "tool_call") {
          assistantParts.push({
            type: "toolCall",
            callId: event.callId,
            name: event.name,
            arguments: event.arguments as JsonObject,
          });
          const approval = await approvals.create({
            runId: payload.runId,
            actionType: `tool:${event.name}`,
            payload: {
              callId: event.callId,
              name: event.name,
              arguments: event.arguments,
              providerInstanceId: resolved.providerInstanceId,
              providerId: resolved.providerId,
              ...(payload.connectionId === undefined ? {} : { connectionId: payload.connectionId }),
            },
            toolCallId: event.callId,
            ...(payload.connectionId === undefined ? {} : { connectionId: payload.connectionId }),
            target: {
              providerInstanceId: resolved.providerInstanceId,
              providerId: resolved.providerId,
              ...(payload.connectionId === undefined ? {} : { connectionId: payload.connectionId }),
            },
            expiresAt: new Date((this.options.now?.() ?? new Date()).getTime() + 10 * 60_000),
          });
          if (assistantParts.length > 0) {
            await conversations.appendAssistantMessage({
              conversationId: payload.conversationId,
              runId: payload.runId,
              content: assistantParts,
            });
          }
          await runs.updateStatus(payload.runId, "waiting_approval", undefined, {
            code: "approval_required",
            message: "A tool action is waiting for approval.",
            approvalId: approval.id,
          });
          await runs.appendEvent(payload.runId, "run.waiting_approval", {
            approvalId: approval.id,
            digest: approval.digest,
            toolCallId: event.callId,
          });
          return { status: "waiting_approval", checkpoint: { approvalId: approval.id } };
        }
      }
      if (await runIsCancelled(runs, payload.runId))
        return cancelledOutcome({
          code: "cancelled",
          message: "Run cancelled by the requester.",
        });
      if (assistantParts.length > 0) {
        const assistantMessage = await conversations.appendAssistantMessage({
          conversationId: payload.conversationId,
          runId: payload.runId,
          content: assistantParts,
        });
        const completed = await runs.updateStatus(
          payload.runId,
          "succeeded",
          usage ? { usage } : undefined,
        );
        if (!completed) {
          const current = await getRunIfPresent(runs, payload.runId);
          if (current?.status === "cancelled") return cancelledOutcome(current.error);
          throw new Error("The conversation run could not be completed");
        }
        await runs.appendEvent(payload.runId, "message.completed", {
          messageId: assistantMessage.id,
          parts: assistantParts,
        });
      } else {
        const completed = await runs.updateStatus(
          payload.runId,
          "succeeded",
          usage ? { usage } : undefined,
        );
        if (!completed) {
          const current = await getRunIfPresent(runs, payload.runId);
          if (current?.status === "cancelled") return cancelledOutcome(current.error);
          throw new Error("The conversation run could not be completed");
        }
        await runs.appendEvent(payload.runId, "message.completed", {
          messageId: payload.messageId,
          parts: [],
        });
      }
      await runs.appendEvent(payload.runId, "run.completed", {
        runId: payload.runId,
      });
      return { status: "succeeded" };
    } catch (error) {
      const persistedCancellation = isPersistedCancellation(context.signal.reason);
      if (persistedCancellation || (await runIsCancelled(runs, payload.runId))) {
        const reason = persistedCancellation
          ? context.signal.reason.message
          : "Run cancelled by the requester.";
        const cancelled = await runs.cancel(payload.runId, reason);
        return cancelledOutcome(cancelled.error);
      }
      const uncertain = isUnknownOutcome(error);
      const message = safeFailureMessage(error, uncertain);
      const failed = await runs.updateStatus(
        payload.runId,
        uncertain ? "outcome_unknown" : "failed",
        undefined,
        {
          code: uncertain ? "provider_unknown_outcome" : "provider_failed",
          message,
        },
      );
      if (!failed) {
        const current = await getRunIfPresent(runs, payload.runId);
        if (current?.status === "cancelled") return cancelledOutcome(current.error);
        throw new Error("The conversation run could not be failed", { cause: error });
      }
      await runs.appendEvent(payload.runId, uncertain ? "run.failed" : "run.failed", {
        uncertain,
        message,
      });
      if (uncertain)
        return { status: "outcome_unknown", error: { message: "Provider outcome is unknown." } };
      return {
        status: "failed",
        error: { message },
      };
    } finally {
      if (resolved) {
        try {
          await resolved.client.close("conversation task complete");
        } catch (error) {
          const message = safeFailureMessage(error, false);
          await runs
            .updateStatus(payload.runId, "failed", undefined, {
              code: "provider_failed",
              message: "The model provider could not release its resources.",
            })
            .catch(() => undefined);
          await runs
            .appendEvent(payload.runId, "run.failed", {
              uncertain: false,
              message: "The model provider could not release its resources.",
              detail: message,
            })
            .catch(() => undefined);
          // The terminal state and event are persisted above. The original
          // task outcome remains the authoritative provider result; cleanup
          // failure is still visible to operators instead of being swallowed.
        }
      }
    }
  }

  private async persistEvent(runs: RunRepository, runId: string, event: ModelEvent): Promise<void> {
    if (event.type === "text_delta") {
      await runs.appendEvent(runId, "message.delta", { text: event.text });
    } else if (event.type === "reasoning_delta") {
      await runs.appendEvent(runId, "message.delta", {
        reasoning: "[REDACTED]",
        redacted: true,
      });
    } else if (event.type === "tool_call") {
      await runs.appendEvent(runId, "tool.call", {
        callId: event.callId,
        name: event.name,
        arguments: event.arguments,
      });
    } else if (event.type === "usage") {
      await runs.appendEvent(runId, "run.progress", { usage: event });
    } else {
      await runs.appendEvent(runId, "run.progress", { finishReason: event.finishReason });
    }
  }
}

function parsePayload(value: Record<string, unknown>): ConversationTaskPayload {
  const runId = typeof value.runId === "string" ? value.runId : "";
  const conversationId = typeof value.conversationId === "string" ? value.conversationId : "";
  const messageId = typeof value.messageId === "string" ? value.messageId : "";
  if (!runId || !conversationId || !messageId)
    throw new Error("Conversation task payload is invalid");
  return {
    runId,
    conversationId,
    messageId,
    ...(typeof value.providerInstanceId === "string"
      ? { providerInstanceId: value.providerInstanceId }
      : {}),
    ...(typeof value.providerId === "string" ? { providerId: value.providerId } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(typeof value.connectionId === "string" ? { connectionId: value.connectionId } : {}),
    ...(Array.isArray(value.tools) ? { tools: value.tools as ModelToolDefinition[] } : {}),
  };
}

function toModelMessage(row: {
  role: string;
  content: unknown;
  runId: string | null;
}): ModelMessage {
  const role =
    row.role === "assistant" || row.role === "tool" || row.role === "system" ? row.role : "user";
  return { role, parts: row.content as MessagePart[] };
}

function isUnknownOutcome(error: unknown): boolean {
  return error instanceof ProviderOperationError && error.uncertain;
}

function safeFailureMessage(error: unknown, uncertain: boolean): string {
  if (uncertain) return "The provider outcome could not be determined.";
  if (error instanceof ProviderOperationError) return error.safeMessage;
  return "The model provider could not complete the request.";
}

function isPersistedCancellation(reason: unknown): reason is PersistedTaskCancellation {
  return (
    reason !== null &&
    typeof reason === "object" &&
    (reason as { kind?: unknown }).kind === "persisted_cancel" &&
    typeof (reason as { message?: unknown }).message === "string"
  );
}

type ConversationRun = Awaited<ReturnType<RunRepository["get"]>>;

async function getRunIfPresent(
  runs: RunRepository,
  runId: string,
): Promise<ConversationRun | undefined> {
  try {
    return await runs.get(runId);
  } catch (error) {
    if (error instanceof RepositoryError && error.code === "not_found") return undefined;
    throw error;
  }
}

async function runIsCancelled(runs: RunRepository, runId: string): Promise<boolean> {
  return (await getRunIfPresent(runs, runId))?.status === "cancelled";
}

function cancelledOutcome(error: unknown): TaskOutcome {
  const message =
    error &&
    typeof error === "object" &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : "Run cancelled by the requester.";
  return { status: "cancelled", error: { code: "cancelled", message } };
}
