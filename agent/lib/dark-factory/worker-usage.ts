/**
 * Dark Factory — worker usage recording (#209, epic #206 R7.3).
 *
 * The worker-side counterpart of `scripts/pr-reviewer-usage.ts`: it appends a
 * usage event when a developer/tester task completes, carrying whatever was
 * actually MEASURED.
 *
 * A worker's LLM call runs inside the sandbox, so tokens and cost are usually
 * not observable from here. The event is still recorded — with those fields
 * ABSENT — which is precisely what the honesty rule exists for: the dashboard
 * shows `—`, and the event counts toward `unmeasured` rather than pretending the
 * task cost nothing.
 *
 * Recording is OPT-IN and BEST-EFFORT: a ledger outage, or a malformed event,
 * must never fail the task. Every suppressed failure is logged, so "best-effort"
 * never means "silently broken".
 */

import {
  BufferedUsageRecorder,
  recordSafely,
  type UsageStore,
} from "./usage-store";
import {
  createUsageStore,
  isUsageRecordingConfigured,
} from "./usage-store-provider";
import type { UsageEvent } from "./usage-ledger";

export interface WorkerUsageContext {
  runId: string;
  model: string;
  pbiId?: number;
}

export interface WorkerUsageMeasurement {
  /** Defaults to `developer`. */
  taskType?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  ts?: string;
}

export class WorkerUsageRecorder {
  private readonly store: UsageStore;
  private readonly context: WorkerUsageContext;

  constructor(store: UsageStore, context: WorkerUsageContext) {
    this.store = store;
    this.context = context;
  }

  /**
   * Append one task-completion event. Resolves `false` instead of throwing on
   * ANY failure, including a malformed event, because telemetry must never fail
   * the task it is measuring.
   */
  async record(measurement: WorkerUsageMeasurement = {}): Promise<boolean> {
    try {
      const event: UsageEvent = {
        runId: this.context.runId,
        ...(this.context.pbiId !== undefined
          ? { pbiId: this.context.pbiId }
          : {}),
        taskType: measurement.taskType ?? "developer",
        model: this.context.model,
        ...(measurement.tokensIn !== undefined
          ? { tokensIn: measurement.tokensIn }
          : {}),
        ...(measurement.tokensOut !== undefined
          ? { tokensOut: measurement.tokensOut }
          : {}),
        ...(measurement.costUsd !== undefined
          ? { costUsd: measurement.costUsd }
          : {}),
        ...(measurement.durationMs !== undefined
          ? { durationMs: measurement.durationMs }
          : {}),
        ts: measurement.ts ?? new Date().toISOString(),
      };

      const result = await recordSafely(this.store, event);
      if (!result.ok) {
        console.warn(
          `[usage] worker usage was not recorded: ${result.error ?? "unknown error"}`,
        );
      }
      return result.ok;
    } catch (error) {
      console.warn(
        `[usage] worker usage event was rejected and not recorded: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}

/**
 * Returns a buffered recorder only when recording is configured; else `null`.
 *
 * The buffer is what makes "a ledger outage must not fail the task" hold at the
 * call site: a failed write is retained for a later flush.
 */
export function createWorkerUsageRecorder(
  env: Record<string, string | undefined>,
  context: WorkerUsageContext,
): WorkerUsageRecorder | null {
  if (!isUsageRecordingConfigured(env)) return null;
  return new WorkerUsageRecorder(
    new BufferedUsageRecorder(createUsageStore(env)),
    context,
  );
}