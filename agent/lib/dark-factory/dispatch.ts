import type { StateReadResult, StateStore } from "./state";

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

/**
 * The handler has PARKED the run on a human decision — a worker question (#162).
 *
 * Deliberately not an ordinary failure: parking must not consume the retry
 * budget or burn backoff sleeps, and the run resumes when a human replies. A
 * genuine error still throws its own error and retries as before.
 */
export class ParkedRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParkedRunError";
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
  | "failed"
  /**
   * Parked on a HUMAN decision (#162). Deliberately distinct from "retrying": a
   * parked run is not failing and must not consume retries or backoff, because
   * waiting for an answer is not work. It is a real status rather than a shadow
   * record so anything reading dispatch state can tell the two apart without a
   * second lookup.
   */
  | "blocked";

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
  /**
   * "This call was handled without an error" — NOT "the run succeeded".
   * A deduplicated delivery is `ok: true` even when the earlier run FAILED,
   * because the duplicate was handled correctly; read `status` for the run's
   * real state and `duplicate` to know that no work was performed.
   */
  ok: boolean;
  status: DispatchStatus;
  attempts: number;
  worker?: string;
  duplicate?: boolean;
  error?: string;
}

/**
 * A single worker invocation must not hold the delivery loop open forever. A
 * hung handler otherwise blocks the retry loop indefinitely (and on serverless
 * the function would be killed with no structured outcome); the deadline
 * converts it into an ordinary failed attempt that retries or terminates.
 */
export const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;

export interface DispatcherOptions {
  store: StateStore;
  handler: (event: DispatchEvent, worker: string) => Promise<void>;
  policy?: RetryPolicy;
  /**
   * Deadline for ONE handler invocation, in ms. Defaults to
   * `DEFAULT_HANDLER_TIMEOUT_MS`; 0 or a negative value disables the deadline
   * (useful for a worker that is legitimately long-running).
   *
   * The deadline bounds the LOOP, not the worker: JavaScript cannot cancel an
   * in-flight promise, so the abandoned attempt may still finish in the
   * background — it simply stops blocking delivery.
   */
  handlerTimeoutMs?: number;
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
  private readonly handlerTimeoutMs: number;

  constructor(options: DispatcherOptions) {
    this.store = options.store;
    this.handler = options.handler;
    this.policy = options.policy ?? DEFAULT_RETRY_POLICY;
    this.route = options.route ?? (() => "developer");
    this.observer = options.observer ?? (() => {});
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Bound one handler invocation.
   *
   * `Promise.race` attaches a rejection handler to EVERY promise it is given,
   * including the one that loses, so an abandoned attempt that later rejects
   * cannot surface as an unhandled rejection. (Measured, not assumed: with an
   * `unhandledRejection` listener installed, a control promise with no handler
   * fires while an abandoned-race promise rejecting after the deadline does not.)
   * `finally` clears the timer so a fast handler does not hold the event loop.
   */
  private async withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
    if (!Number.isFinite(this.handlerTimeoutMs) || this.handlerTimeoutMs <= 0) return work;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded the ${this.handlerTimeoutMs}ms deadline`)),
        this.handlerTimeoutMs,
      );
    });

    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Persist dispatch state, converting BOTH failure shapes into a message the
   * caller can return: a structured `{ ok: false }` result, and a store
   * implementation that throws instead (the seam permits async backends whose
   * driver rejects). Retries must survive a process restart, so an un-persisted
   * write is fatal for the operation rather than something to swallow.
   *
   * Returns null on success.
   */
  private async persist(record: DispatchRecord): Promise<string | null> {
    const runId = record.event.runId;
    try {
      const res = await this.store.save(dispatchKey(runId), record);
      if (!res.ok) {
        return `Cannot persist dispatch state for run '${runId}': ${res.error ?? "unknown error"}`;
      }
      return null;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `Cannot persist dispatch state for run '${runId}': store threw: ${detail}`;
    }
  }

  async dispatch(event: DispatchEvent): Promise<DispatchOutcome> {
    let existing: StateReadResult<DispatchRecord>;
    try {
      existing = await this.store.get<DispatchRecord>(dispatchKey(event.runId));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: "failed",
        attempts: 0,
        error: `Cannot read dispatch state for run '${event.runId}': store threw: ${detail}`,
      };
    }
    if (!existing.ok) {
      return {
        ok: false,
        status: "failed",
        attempts: 0,
        error: `Cannot read dispatch state for run '${event.runId}': ${existing.error ?? "unknown error"}`,
      };
    }
    if (existing.value && existing.value.status !== "blocked") {
      // At-most-once: anything already recorded for this run (in flight or
      // finished) is a duplicate delivery, never a second dispatch.
      //
      // A BLOCKED run is the one exception, and it is not really an exception:
      // at-most-once exists to stop duplicate WORK, and a parked run has no work
      // in flight. So a fresh delivery after the human replied is the resume
      // signal, not a duplicate (#162).
      //
      // `ok` here means "this call was handled with no error" — NOT "the run
      // succeeded". A duplicate of a previously FAILED run is still a
      // successfully handled duplicate, so `ok` is true and the run's real
      // state travels in `status` (plus `duplicate: true` to say no work was
      // performed). Reporting `ok: false` for a duplicate would conflate "this
      // request errored" with "the earlier run failed" and invite a caller to
      // re-dispatch — the exact thing this guard exists to prevent.
      return {
        ok: true,
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
    const basePersistError = await this.persist(base);
    if (basePersistError) {
      return { ok: false, status: "failed", attempts: 0, worker, error: basePersistError };
    }

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
        await this.withDeadline(
          this.handler(event, worker),
          `handler for run '${event.runId}' (attempt ${attempt})`,
        );
      } catch (err) {
        // Parked on a human: record it truthfully and STOP. No retry, no backoff
        // sleep - a human reading a question must not burn worker-minutes (#162).
        if (err instanceof ParkedRunError) {
          const parkError = err.message;
          const parkedPersistError = await this.persist({
            ...base,
            status: "blocked",
            attempts: attempt,
            updatedAt: new Date().toISOString(),
            error: parkError,
          });
          if (parkedPersistError) {
            return {
              ok: false,
              status: "failed",
              attempts: attempt,
              worker,
              error: parkedPersistError,
            };
          }
          await this.observer({
            type: "dispatch.attempt",
            runId: event.runId,
            attempt,
            status: "blocked",
            worker,
          });
          return { ok: true, status: "blocked", attempts: attempt, worker };
        }

        lastError = err instanceof Error ? err.message : String(err);
        const schedule = nextRetry(this.policy, attempt);
        if (!schedule) break;

        const retryPersistError = await this.persist({
          ...base,
          status: "retrying",
          attempts: attempt,
          updatedAt: new Date().toISOString(),
          error: lastError,
        });
        if (retryPersistError) {
          return {
            ok: false,
            status: "failed",
            attempts: attempt,
            worker,
            error: retryPersistError,
          };
        }
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

      const successPersistError = await this.persist({
        ...base,
        status: "succeeded",
        attempts: attempt,
        updatedAt: new Date().toISOString(),
      });
      if (successPersistError) {
        // The worker did the work, but the outcome could not be recorded, so the
        // at-most-once guard is not durable. Report the error rather than a clean
        // success that would hide a lost state write.
        return {
          ok: false,
          status: "failed",
          attempts: attempt,
          worker,
          error: successPersistError,
        };
      }
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
    const terminalPersistError = await this.persist({
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
    return {
      ok: false,
      status: "failed",
      attempts: attempt,
      worker,
      error: terminalPersistError ? `${lastError} (also: ${terminalPersistError})` : lastError,
    };
  }
}