import type { Schedule } from "@openmuse/contracts";
import { CoreError } from "./errors.js";

export interface CronNextOccurrence {
  next(expression: string, after: Date, timezone: string): Date | undefined;
}

export function nextOccurrence(schedule: Schedule, after: Date, cron?: CronNextOccurrence): Date | undefined {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    return at.getTime() > after.getTime() ? at : undefined;
  }
  if (schedule.kind === "interval") return new Date(after.getTime() + schedule.everySeconds * 1000);
  if (!cron) throw new CoreError("cron_adapter_required", "A cron adapter is required for this schedule.");
  return cron.next(schedule.expression, after, schedule.timezone);
}

export interface RunBudgetLimits {
  maxDurationMs?: number;
  maxProviderCalls?: number;
  maxOutputBytes?: number;
  maxChildRuns?: number;
}

export interface RunBudgetUsage {
  durationMs: number;
  providerCalls: number;
  outputBytes: number;
  childRuns: number;
}

export class RunBudgetExceededError extends CoreError {
  constructor(metric: keyof RunBudgetUsage) {
    super("run_budget_exceeded", `The run exceeded its ${metric} budget.`, { metric });
    this.name = "RunBudgetExceededError";
  }
}

export class RunBudget {
  private usage: RunBudgetUsage = { durationMs: 0, providerCalls: 0, outputBytes: 0, childRuns: 0 };

  constructor(private readonly limits: RunBudgetLimits) {}

  snapshot(): RunBudgetUsage { return { ...this.usage }; }

  record(metric: keyof RunBudgetUsage, amount: number): void {
    if (!Number.isFinite(amount) || amount < 0) throw new CoreError("invalid_budget_amount", "Budget amounts must be finite and non-negative.");
    this.usage[metric] += amount;
    const limit = this.limits[metric === "durationMs" ? "maxDurationMs" : metric === "providerCalls" ? "maxProviderCalls" : metric === "outputBytes" ? "maxOutputBytes" : "maxChildRuns"];
    if (limit !== undefined && this.usage[metric] > limit) throw new RunBudgetExceededError(metric);
  }
}
