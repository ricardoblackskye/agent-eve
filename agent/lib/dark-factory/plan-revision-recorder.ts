/**
 * Dark Factory — how many times a parked plan has been sent back (#378).
 *
 * A reply that is not an explicit approval is plan feedback, which costs one architect call and re-parks
 * the run. That is deliberately safe, but it is not free and not unbounded: an unrelated comment or a
 * chatty thread could send the architect round the loop forever. This module is the durable count the
 * runner refuses against.
 *
 * A round is recorded as `run.resumed`, because that is what the reply IS. The ledger's state machine
 * allows a BLOCKED run to receive only `run.resumed` or `run.terminal`, and that rule is load-bearing -
 * it is what stops a parked run accumulating work while it waits. An earlier design recorded a dedicated
 * `run.plan_revised` event while the run was blocked; the ledger refused it, correctly, and the fix was
 * to stop inventing an event instead of widening the guard.
 *
 * Mirrors `breaker-trip-recorder.ts` and `cost-refusal-recorder.ts` deliberately — same append shape,
 * same idempotency on a derived event id, same honest failure reporting instead of throwing.
 */
import { createHash } from "node:crypto";
import type { EventCursor } from "./run-history-store";
import type { RunHistoryStore } from "./run-history-store";
import type { PlanCommentRef, PlanRecordInput, PlanSource } from "./plan-ledger";
import type { ExecutionPlan } from "./plan-validator";

export interface RecordPlanRevisionInput {
  runId: string;
  /**
   * Identity of the human reply that asked for the revision, so a re-delivered comment records ONCE.
   * The delivery identity is what the human DID, not GitHub's own delivery id.
   */
  revisionId: string;
  occurredAt?: string;
}

export interface PlanRevisionWriteResult {
  ok: boolean;
  error?: string;
}

export interface PlanRevisionCountResult {
  ok: boolean;
  count: number;
  error?: string;
}

/**
 * Page size for reading a run's events.
 *
 * 100 is the STORE'S maximum: `listRunEvents` rejects anything outside [1, 100] by THROWING. A larger
 * page looked reasonable and was the live end-to-end run's first failure — the rejection escaped the
 * whole revision branch, because a store that refuses by throwing is a second error shape.
 */
const EVENT_PAGE_SIZE = 100;

/** A ceiling on paging, so a cursor that never advances cannot spin forever. */
const MAX_EVENT_PAGES = 50;

/** One revision round is one reply-resume, so the count is the count of those. */
export function countPlanRevisions(events: readonly { type: string }[]): number {
  return events.filter((event) => event?.type === "run.resumed").length;
}

/**
 * Has the revision budget been spent?
 *
 * A named predicate rather than an inline `>=` at the call site: the EXACT boundary is the interesting
 * case (a run that has already used all five rounds must stop, not start a sixth), and an off-by-one
 * there is invisible in a passing end-to-end run.
 */
export function isPlanRevisionCapReached(count: number, cap: number): boolean {
  return count >= cap;
}

/** Idempotent on (run, reply): the same reply can never count as two rounds. */
function planRevisionEventId(runId: string, revisionId: string): string {
  const hash = createHash("sha256")
    .update(`${runId}:${revisionId}`)
    .digest("hex")
    .slice(0, 32);
  return `plan-revision-resume:${hash}`;
}

/**
 * Record the round by resuming the parked run.
 *
 * This moves the run from `blocked` to `running`, which is both the truthful record of what happened (a
 * human replied) and the only transition the ledger permits from `blocked`. The run parks again when the
 * amended plan is posted, so the pair of transitions describes the round exactly.
 *
 * Returns `{ ok: false, error }` rather than throwing: the caller still has to report the outcome and
 * re-park, so a ledger outage must not turn an unrecorded round into an unreported one.
 */
export async function recordPlanRevision(
  history: RunHistoryStore,
  input: RecordPlanRevisionInput,
): Promise<PlanRevisionWriteResult> {
  const written = await history.appendEvent({
    eventId: planRevisionEventId(input.runId, input.revisionId),
    runId: input.runId,
    type: "run.resumed",
    stage: "dispatch",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    status: "running",
  });
  return written.ok
    ? { ok: true }
    : {
        ok: false,
        error: written.error ?? "the plan revision could not be persisted",
      };
}

/**
 * Count the run's revision rounds, paging through ALL of its events.
 *
 * Fails CLOSED on an unreadable ledger: it reports the failure rather than answering zero. Reporting
 * zero would let a revision through a cap the operator believes is enforced, which is the same class of
 * silent-default bug as treating a malformed env value as unset.
 *
 * A store that REJECTS is handled the same way as one that returns a failure result, because both are
 * "we could not read this" — leaving the rejection unhandled is what aborted the live run.
 */
export async function readPlanRevisionCount(
  history: RunHistoryStore,
  runId: string,
): Promise<PlanRevisionCountResult> {
  let cursor: EventCursor | undefined;
  let count = 0;

  try {
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const listed = await history.listRunEvents(
        runId,
        cursor === undefined
          ? { limit: EVENT_PAGE_SIZE }
          : { limit: EVENT_PAGE_SIZE, after: cursor },
      );
      if (!listed.ok || !listed.value) {
        return {
          ok: false,
          count,
          error: listed.error ?? "the run's events could not be read",
        };
      }

      count += countPlanRevisions(listed.value.items.map((item) => item.event));

      const next = listed.value.nextCursor;
      if (next === undefined) {
        return { ok: true, count };
      }
      cursor = next;
    }
  } catch (error) {
    return {
      ok: false,
      count,
      error: `the run's events could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  return {
    ok: false,
    count,
    error: `the run's events did not finish paging after ${MAX_EVENT_PAGES} pages`,
  };
}

/**
 * Persist the plan the runner just posted (#505).
 *
 * The runner posts the plan as a comment BEFORE coding so it is reviewable; without this the plan is
 * only ever a comment and `df_plans` stays empty. This is the single write seam for that.
 *
 * Contract:
 *  - a configured store records the revision and reports its `planId`;
 *  - the refusing console/dry-run store is SKIPPED LOUDLY (`{ ok: false, skipped: true }`) — a missing
 *    driver is a configuration choice, not a silent no-op, and must not abort an intentional dry-run;
 *  - anything else (a real DB error, a broken store) PROPAGATES — fail-closed, because an unrecorded
 *    plan in a real run is a defect we must not hide.
 */
export interface RecordPostedPlanInput {
  runId: string;
  planRevision: number;
  plan: ExecutionPlan;
  source: PlanSource;
  /** Reference to the GitHub comment holding the plan, when the caller has it. */
  commentRef?: PlanCommentRef;
  occurredAt?: string;
}

export interface PostedPlanWriteResult {
  ok: boolean;
  /** The refusing console/dry-run store: nothing was written, and that is not an error. */
  skipped?: boolean;
  planId?: number;
  error?: string;
}

export async function recordPostedPlan(
  history: RunHistoryStore,
  input: RecordPostedPlanInput,
): Promise<PostedPlanWriteResult> {
  const record: PlanRecordInput = {
    runId: input.runId,
    planRevision: input.planRevision,
    storyId: input.plan.storyId,
    source: input.source,
    plan: input.plan,
    ...(input.commentRef ? { commentRef: input.commentRef } : {}),
    createdAt: input.occurredAt ?? new Date().toISOString(),
  };

  try {
    const persisted = await history.recordPlan(record);
    return { ok: true, planId: persisted.planId };
  } catch (error) {
    // The console/dry-run store refuses by THROWING (RunHistoryConfigurationError). Detect it by name
    // so this module depends only on the store INTERFACE, not the provider factory.
    if (error instanceof Error && error.name === "RunHistoryConfigurationError") {
      return { ok: false, skipped: true, error: error.message };
    }
    throw error;
  }
}
