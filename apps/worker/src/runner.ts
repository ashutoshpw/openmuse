import type { Task } from "@openmuse/db";
import {
  RepositoryError,
  ScopedDatabase,
  TaskRepository,
  WorkspaceRepository,
  type OpenMuseDatabase,
} from "@openmuse/db";
import type {
  DurableTaskHandler,
  PersistedTaskCancellation,
  TaskExecutionContext,
} from "@openmuse/application";
import { ProviderOperationError } from "@openmuse/provider-contracts";

export interface WorkerScope {
  workspaceId: string;
  actorId: string;
}

export interface DurableWorkerOptions {
  workerId: string;
  scopes?: readonly WorkerScope[];
  discoverScopes?: () => Promise<readonly WorkerScope[]>;
  handlers: readonly DurableTaskHandler[];
  pollMs?: number;
  leaseMs?: number;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
}

/**
 * Polling is intentionally scope-driven. A worker may use explicit scopes or
 * the narrowly privileged pending-scope discovery function, but every claim
 * and execution rechecks active membership under the discovered actor and
 * workspace RLS context. Leases are fenced by worker ID plus a unique token;
 * expired provider work is marked `outcome_unknown`, never automatically
 * replayed.
 */
export class DurableWorker {
  private readonly handlers: ReadonlyMap<string, DurableTaskHandler>;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private readonly controller = new AbortController();

  constructor(
    private readonly db: { db: OpenMuseDatabase },
    private readonly options: DurableWorkerOptions,
  ) {
    if (!options.workerId.trim()) throw new Error("WORKER_ID is required");
    if ((options.scopes?.length ?? 0) === 0 && !options.discoverScopes)
      throw new Error("At least one worker scope or pending-scope discovery is required");
    this.handlers = new Map(options.handlers.map((handler) => [handler.kind, handler]));
    this.pollMs = Math.max(250, options.pollMs ?? 1000);
    this.leaseMs = Math.max(5000, options.leaseMs ?? 30_000);
    if (options.signal?.aborted) this.controller.abort(options.signal.reason);
    else
      options.signal?.addEventListener(
        "abort",
        () => this.controller.abort(options.signal?.reason),
        { once: true },
      );
  }

  stop(reason = "worker stopped"): void {
    this.controller.abort(reason);
  }

  async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      let worked = false;
      let scopes: readonly WorkerScope[] = [];
      try {
        scopes = await this.resolveScopes();
      } catch (error) {
        this.reportError(error);
      }
      for (const scope of scopes) {
        if (this.controller.signal.aborted) break;
        try {
          const claimed = await this.claim(scope);
          if (!claimed) continue;
          worked = true;
          await this.execute(scope, claimed.task, claimed.fenceToken);
        } catch (error) {
          this.reportError(error);
        }
      }
      if (!worked) await wait(this.pollMs, this.controller.signal);
    }
  }

  private async resolveScopes(): Promise<readonly WorkerScope[]> {
    const discovered = this.options.discoverScopes ? await this.options.discoverScopes() : [];
    const unique = new Map<string, WorkerScope>();
    for (const scope of [...(this.options.scopes ?? []), ...discovered]) {
      if (!scope.workspaceId.trim() || !scope.actorId.trim()) continue;
      unique.set(`${scope.workspaceId}:${scope.actorId}`, scope);
    }
    return [...unique.values()];
  }

  private reportError(error: unknown): void {
    const safe = redactError(error);
    if (this.options.onError) this.options.onError(safe);
    else console.error("openmuse_worker_error", safe);
  }

  private async isActiveMember(scope: WorkerScope): Promise<boolean> {
    try {
      await new WorkspaceRepository(
        new ScopedDatabase(this.db.db, {
          workspaceId: scope.workspaceId,
          actorId: scope.actorId,
        }),
      ).getWithMembership();
      return true;
    } catch (error) {
      if (
        error instanceof RepositoryError &&
        (error.code === "not_found" || error.code === "forbidden")
      )
        return false;
      throw error;
    }
  }

  private async claim(scope: WorkerScope) {
    if (!(await this.isActiveMember(scope))) return null;
    const repository = new TaskRepository(new ScopedDatabase(this.db.db, scope));
    return repository.claim(this.options.workerId, this.leaseMs);
  }

  private async execute(scope: WorkerScope, task: Task, fenceToken: string): Promise<void> {
    if (
      task.workspaceId !== scope.workspaceId ||
      task.requestedBy !== scope.actorId ||
      !(await this.isActiveMember(scope))
    )
      return;
    const repository = new TaskRepository(new ScopedDatabase(this.db.db, scope));
    const handler = this.handlers.get(task.kind);
    if (!handler) {
      await repository.complete(task.id, this.options.workerId, fenceToken, "failed", {
        code: "handler_missing",
        message: `No handler registered for ${task.kind}`,
      });
      return;
    }
    const taskController = new AbortController();
    const stop = () => taskController.abort(this.controller.signal.reason);
    if (this.controller.signal.aborted) stop();
    else this.controller.signal.addEventListener("abort", stop, { once: true });

    const heartbeat = async (): Promise<boolean> => {
      if (taskController.signal.aborted) return false;
      try {
        const cancellation = await repository.cancellationState(task.id);
        if (cancellation === "cancelled") {
          taskController.abort({
            kind: "persisted_cancel",
            message: "The task was cancelled by its owner.",
          } satisfies PersistedTaskCancellation);
          return false;
        }
        if (cancellation === "missing") {
          taskController.abort(new Error("Task is no longer visible in its tenant scope"));
          return false;
        }
        const alive = await repository.heartbeat(
          task.id,
          this.options.workerId,
          fenceToken,
          this.leaseMs,
        );
        if (!alive) {
          const state = await repository.cancellationState(task.id);
          if (state === "cancelled") {
            taskController.abort({
              kind: "persisted_cancel",
              message: "The task was cancelled by its owner.",
            } satisfies PersistedTaskCancellation);
          } else {
            taskController.abort(new Error("Task lease was fenced by another worker"));
          }
        }
        return alive;
      } catch (error) {
        this.reportError(error);
        taskController.abort(new Error("Task lease heartbeat failed", { cause: error }));
        return false;
      }
    };

    const heartbeatTimer = setInterval(
      () => void heartbeat(),
      Math.max(1000, Math.floor(this.leaseMs / 3)),
    );
    const context: TaskExecutionContext = {
      signal: taskController.signal,
      workerId: this.options.workerId,
      fenceToken,
      checkpoint: (value) =>
        repository.checkpoint(task.id, this.options.workerId, fenceToken, value).then((ok) => {
          if (!ok) throw new Error("Task checkpoint rejected by lease fence");
        }),
      heartbeat,
    };
    try {
      if (!(await heartbeat())) {
        if (isPersistedCancellation(taskController.signal.reason))
          await repository.complete(task.id, this.options.workerId, fenceToken, "cancelled", {
            code: "cancelled",
            message: taskController.signal.reason.message,
          });
        return;
      }
      const outcome = await handler.execute(task, context);
      if (outcome.status === "waiting_approval") {
        const parked = await repository.waitForApproval(
          task.id,
          this.options.workerId,
          fenceToken,
          outcome.checkpoint,
        );
        if (!parked) throw new Error("Task approval wait was rejected by lease fence");
      } else {
        await repository.complete(
          task.id,
          this.options.workerId,
          fenceToken,
          outcome.status,
          "error" in outcome ? outcome.error : undefined,
        );
      }
    } catch (error) {
      if (isPersistedCancellation(taskController.signal.reason)) {
        await repository.complete(task.id, this.options.workerId, fenceToken, "cancelled", {
          code: "cancelled",
          message: taskController.signal.reason.message,
        });
        return;
      }
      const uncertain = error instanceof ProviderOperationError && error.uncertain;
      const details = {
        code: uncertain ? "provider_unknown_outcome" : "task_failed",
        message: error instanceof Error ? error.message : "Task failed",
      };
      if (uncertain)
        await repository.markOutcomeUnknown(task.id, this.options.workerId, fenceToken, details);
      else await repository.complete(task.id, this.options.workerId, fenceToken, "failed", details);
    } finally {
      clearInterval(heartbeatTimer);
      this.controller.signal.removeEventListener("abort", stop);
    }
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function isPersistedCancellation(reason: unknown): reason is PersistedTaskCancellation {
  return (
    reason !== null &&
    typeof reason === "object" &&
    (reason as { kind?: unknown }).kind === "persisted_cancel" &&
    typeof (reason as { message?: unknown }).message === "string"
  );
}

function redactError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redactText(error.message),
      ...(error.cause === undefined ? {} : { cause: redactError(error.cause) }),
    };
  }
  if (Array.isArray(error)) return error.map(redactError);
  if (error && typeof error === "object") {
    return Object.fromEntries(
      Object.entries(error).map(([key, value]) => [
        key,
        secretKey.test(key) ? "[REDACTED]" : redactError(value),
      ]),
    );
  }
  return typeof error === "string" ? redactText(error) : error;
}

const secretKey = /(token|secret|password|authorization|cookie|api[-_]?key|private[-_]?key)/i;

function redactText(value: string): string {
  return value
    .replace(/bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|password|api[-_]?key)=([^\s&]+)/gi, "$1=[REDACTED]")
    .slice(0, 2048);
}
