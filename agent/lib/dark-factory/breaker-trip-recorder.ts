/**
 * Dark Factory — record a circuit-breaker trip on a run (#313).
 *
 * A trip halts the coding loop (#312). An operator reading the ticket must be able to see
 * WHY it stopped, and what bound was exceeded — not just find it in a log. The trip is
 * stored MACHINE-READABLY (a closed vocabulary of reasons plus the numeric bound), never
 * free text, and the breaker itself stays a pure in-memory guard: it is never taught about
 * the ledger.
 *
 * Mirrors `cost-refusal-recorder.ts` (#270) deliberately — same shape, same idempotency,
 * same honest failure reporting.
 */
import { createHash } from "node:crypto";
import type { BreakerTrip } from "./run-history";
import type { RunHistoryStore } from "./run-history-store";

export interface RecordBreakerTripInput {
  runId: string;
  /** The trip, as the breaker reported it (reason + the cap that was hit). */
  trip: BreakerTrip;
  occurredAt?: string;
}

export interface RecordBreakerTripResult {
  ok: boolean;
  error?: string;
}

/**
 * Append a terminal, failed run event carrying the trip.
 *
 * Idempotent: the event id is derived from the run id (hashed, bounded) and the trip
 * reason, so a retry of the same trip does not duplicate the event while a trip for a
 * DIFFERENT reason remains a distinct event.
 *
 * Returns `{ ok: false, error }` rather than throwing: the caller is a terminal path that
 * must still halt the run and log the trip loudly, so a ledger outage can never turn a
 * recorded trip into a silent one.
 */
export async function recordBreakerTrip(
  history: RunHistoryStore,
  input: RecordBreakerTripInput,
): Promise<RecordBreakerTripResult> {
  const hash = createHash("sha256").update(input.runId).digest("hex").slice(0, 32);
  const written = await history.appendEvent({
    eventId: `breaker-trip:${hash}:${input.trip.reason}`,
    runId: input.runId,
    type: "run.terminal",
    stage: "terminal",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    status: "failed",
    breakerTrip: input.trip,
  });
  return written.ok
    ? { ok: true }
    : {
        ok: false,
        error: written.error ?? "circuit-breaker trip could not be persisted",
      };
}
