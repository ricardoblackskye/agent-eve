/**
 * Dark Factory — how many times a parked plan has been sent back (#378).
 *
 * A reply that is not an explicit approval is plan feedback, which costs one architect call and re-parks
 * the run. That is deliberately safe, but it is not free and not unbounded: an unrelated comment or a
 * chatty thread could send the architect round the loop forever. This module is the durable count the
 * runner refuses against.
 *
 * Mirrors `breaker-trip-recorder.ts` and `cost-refusal-recorder.ts` deliberately — same append shape,
 * same idempotency on a derived event id, same honest failure reporting instead of throwing.
 */
import { createHash } from "node:crypto";
import type { EventCursor } from "./run-history-store";
import type { RunHistoryStore } from "./run-history-store";

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

/** Bounded page size, so reading a long run's events is a few round trips rather than one huge read. */
const EVENT_PAGE_SIZE = 200;

/** A ceiling on paging, so a cursor that never advances cannot spin forever. */
const MAX_EVENT_PAGES = 50;

export function countPlanRevisions(events: readonly { type: string }[]): number {
  return events.filter((event) => event?.type === "run.plan_revised").length;
}

/**
 * Has the revision budget been spent?
 *
 * A named predicate rather than an inline `>=` at the call site: the EXACT boundary is the interesting
 * case (the run that has already used all five rounds must stop, not start a sixth), and an off-by-one
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
  return `plan-revision:${hash}`;
}

/**
 * Append the revision round.
 *
 * Recorded while the run is `blocked`, because the run re-parks around a revision - the status rule in
 * `toRunEvent` refuses the event against any other status, so a revision can never be counted for a run
 * that is happily coding.
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
    type: "run.plan_revised",
    stage: "worker",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    status: "blocked",
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
 */
export async function readPlanRevisionCount(
  history: RunHistoryStore,
  runId: string,
): Promise<PlanRevisionCountResult> {
  let cursor: EventCursor | undefined;
  let count = 0;

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

  return {
    ok: false,
    count,
    error: `the run's events did not finish paging after ${MAX_EVENT_PAGES} pages`,
  };
}
