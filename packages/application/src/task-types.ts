import type { Task } from "@openmuse/db";

export interface TaskExecutionContext {
  readonly signal: AbortSignal;
  readonly workerId: string;
  readonly fenceToken: string;
  checkpoint(value: Record<string, unknown>): Promise<void>;
  heartbeat(): Promise<boolean>;
}

export interface PersistedTaskCancellation {
  readonly kind: "persisted_cancel";
  readonly message: string;
}

export type TaskOutcome =
  | { status: "succeeded" }
  | { status: "failed"; error: Record<string, unknown> }
  | { status: "outcome_unknown"; error: Record<string, unknown> }
  | { status: "cancelled"; error?: Record<string, unknown> }
  | { status: "waiting_approval"; checkpoint?: Record<string, unknown> };

export interface DurableTaskHandler {
  readonly kind: string;
  execute(task: Task, context: TaskExecutionContext): Promise<TaskOutcome>;
}
