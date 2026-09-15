import type { StateStore } from "./state";

/**
 * Dark Factory — Orchestration Core (issues #137 / story #138).
 *
 * STUB — implementation pending (TDD RED).
 */

export interface DispatchEvent {
  runId: string;
  repo: string;
  ref: string;
  status: "failure" | "success" | "cancelled";
}

export class InvalidDispatchEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDispatchEventError";
  }
}

export function toDispatchEvent(input: Partial<DispatchEvent>): DispatchEvent {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) {
    throw new InvalidDispatchEventError(
      `Dispatch event requires a non-empty "runId" (received ${JSON.stringify(input.runId)}).`,
    );
  }
  const repo = typeof input.repo === "string" ? input.repo.trim() : "";
  if (!repo) {
    throw new InvalidDispatchEventError(
      `Dispatch event requires a non-empty "repo" (received ${JSON.stringify(input.repo)}).`,
    );
  }
  return {
    runId,
    repo,
    ref: typeof input.ref === "string" ? input.ref : "",
    status: input.status === "success" || input.status === "cancelled" ? input.status : "failure",
  };
}

/**
 * Dedup identity for an event. Keyed on the CI run alone: the same run must be
 * processed at most once no matter how many times GitHub re-delivers it, and a
 * re-delivery may legitimately arrive with a different `ref`.
 */
export function dedupKey(event: DispatchEvent): string {
  return `ci:${event.runId}`;
}

/** Canonical store key for an event's dispatch state. */
export function dispatchKey(runId: string): string {
  return `dispatch:${runId}`;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1000,
  backoffMultiplier: 3,
};

export interface RetrySchedule {
  attempt: number;
  delayMs: number;
}

export function nextRetry(policy: RetryPolicy, failedAttempt: number): RetrySchedule | null {
  if (failedAttempt >= policy.maxRetries + 1) return null;
  return {
    attempt: failedAttempt + 1,
    delayMs: policy.baseDelayMs * policy.backoffMultiplier ** (failedAttempt - 1),
  };
}

export type DispatchStatus =
  | "pending"
  | "dispatched"
  | "retrying"
  | "succeeded"
  | "failed";

export interface DispatchRecord {
  event: DispatchEvent;
  worker: string;
  status: DispatchStatus;
  attempts: number;
  updatedAt: string;
  error?: string;
}

export interface DispatchAttemptMetric {
  type: "dispatch.attempt";
  runId: string;
  attempt: number;
  status: DispatchStatus;
  worker: string;
  delayMs?: number;
}

/**
 * Receives each structured dispatch-attempt event. May be async: `dispatch`
 * awaits every emission so a metrics sink can never lose an event to a floating
 * promise (see the no-loss constraint in #140).
 */
export type DispatchObserver = (metric: DispatchAttemptMetric) => void | Promise<void>;

export interface DispatchOutcome {
  ok: boolean;
  status: DispatchStatus;
  attempts: number;
  worker?: string;
  duplicate?: boolean;
  error?: string;
}

export interface DispatcherOptions {
  store: StateStore;
  handler: (event: DispatchEvent, worker: string) => Promise<void>;
  policy?: RetryPolicy;
  route?: (event: DispatchEvent) => string;
  observer?: DispatchObserver;
  sleep?: (ms: number) => Promise<void>;
}

export class Dispatcher {
  private readonly store: StateStore;
  private readonly handler: (event: DispatchEvent, worker: string) => Promise<void>;
  private readonly policy: RetryPolicy;
  private readonly route: (event: DispatchEvent) => string;
  private readonly observer: DispatchObserver;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: DispatcherOptions) {
    this.store = options.store;
    this.handler = options.handler;
    this.policy = options.policy ?? DEFAULT_RETRY_POLICY;
    this.route = options.route ?? (() => "developer");
    this.observer = options.observer ?? (() => {});
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Persist dispatch state. A store that cannot persist is fatal for this
   * operation: retries must survive a process restart, so silently continuing
   * with un-persisted state would break the at-most-once guarantee.
   */
  private async persist(record: DispatchRecord): Promise<void> {
    const res = await this.store.save(dispatchKey(record.event.runId), record);
    if (!res.ok) {
      throw new Error(
        `Cannot persist dispatch state for run '${record.event.runId}': ${res.error ?? "unknown error"}`,
      );
    }
  }

  async dispatch(event: DispatchEvent): Promise<DispatchOutcome> {
    const existing = await this.store.get<DispatchRecord>(dispatchKey(event.runId));
    if (!existing.ok) {
      return {
        ok: false,
        status: "failed",
        attempts: 0,
        error: `Cannot read dispatch state for run '${event.runId}': ${existing.error ?? "unknown error"}`,
      };
    }
    if (existing.value) {
      // At-most-once: anything already recorded for this run (in flight or
      // finished) is a duplicate delivery, never a second dispatch.
      return {
        ok: existing.value.status === "succeeded",
        status: existing.value.status,
        attempts: existing.value.attempts,
        worker: existing.value.worker,
        duplicate: true,
      };
    }

    const worker = this.route(event);
    const base: DispatchRecord = {
      event,
      worker,
      status: "pending",
      attempts: 0,
      updatedAt: new Date().toISOString(),
    };
    await this.persist(base);

    let attempt = 0;
    let lastError = "";

    for (;;) {
      attempt += 1;
      await this.observer({
        type: "dispatch.attempt",
        runId: event.runId,
        attempt,
        status: "dispatched",
        worker,
      });

      try {
        await this.handler(event, worker);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const schedule = nextRetry(this.policy, attempt);
        if (!schedule) break;

        await this.persist({
          ...base,
          status: "retrying",
          attempts: attempt,
          updatedAt: new Date().toISOString(),
          error: lastError,
        });
        await this.observer({
          type: "dispatch.attempt",
          runId: event.runId,
          attempt,
          status: "retrying",
          worker,
          delayMs: schedule.delayMs,
        });
        await this.sleep(schedule.delayMs);
        continue;
      }

      await this.persist({
        ...base,
        status: "succeeded",
        attempts: attempt,
        updatedAt: new Date().toISOString(),
      });
      await this.observer({
        type: "dispatch.attempt",
        runId: event.runId,
        attempt,
        status: "succeeded",
        worker,
      });
      return { ok: true, status: "succeeded", attempts: attempt, worker };
    }

    // Retry budget exhausted — terminal failure, never an infinite retry.
    await this.persist({
      ...base,
      status: "failed",
      attempts: attempt,
      updatedAt: new Date().toISOString(),
      error: lastError,
    });
    await this.observer({
      type: "dispatch.attempt",
      runId: event.runId,
      attempt,
      status: "failed",
      worker,
    });
    return { ok: false, status: "failed", attempts: attempt, worker, error: lastError };
  }
}