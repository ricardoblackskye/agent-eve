/**
 * Dark Factory — record a cost refusal on a run (#270).
 *
 * A cost-governed LLM call that the governor refused must be visible ON THE RUN,
 * not just in a log: an operator reading the ticket needs to know a run stopped
 * because of budget/model/configuration, and which. The refusal reason is stored
 * as a MACHINE-READABLE code (a `CostGovernorRefusal`), never free text.
 */
import { createHash } from "node:crypto";
import type { CostGovernorRefusal } from "./cost-governor";
import type { RunHistoryStore } from "./run-history-store";

export interface RecordCostRefusalInput {
  runId: string;
  /** The machine-readable reason the call was refused. */
  code: CostGovernorRefusal;
  occurredAt?: string;
}

export interface RecordCostRefusalResult {
  ok: boolean;
  error?: string;
}

/**
 * Append a terminal, failed run event carrying the refusal code.
 *
 * Idempotent: the event id is derived from the run id (hashed, bounded) and the
 * code, so a retry of the same refusal does not duplicate the event and a
 * DIFFERENT code is a distinct event.
 */
export async function recordCostRefusal(
  history: RunHistoryStore,
  input: RecordCostRefusalInput,
): Promise<RecordCostRefusalResult> {
  const hash = createHash("sha256").update(input.runId).digest("hex").slice(0, 32);
  const written = await history.appendEvent({
    eventId: `cost-refusal:${hash}:${input.code}`,
    runId: input.runId,
    type: "run.terminal",
    stage: "terminal",
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    status: "failed",
    costRefusal: input.code,
  });
  return written.ok
    ? { ok: true }
    : {
        ok: false,
        error: written.error ?? "cost refusal could not be persisted",
      };
}
