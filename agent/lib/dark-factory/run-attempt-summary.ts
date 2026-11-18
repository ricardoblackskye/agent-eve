import type { RunStatus, RunSummary } from "./run-history";

/**
 * The summary for a run the LEDGER never minted (#681).
 *
 * `beginRunRecord` can return without a ledger run - the store being unreachable is the case that
 * happens in practice - and then reports `fellBack: true` with the ATTEMPT id as the run id. The
 * runner carries on regardless: it clones, plans, codes and opens a pull request, and every one of
 * those writes targets a run the ledger has never heard of. Nothing reading the run history can see
 * that the run happened.
 *
 * The status is deliberately TERMINAL, and that is not cosmetic. `df_run_active_issue_uidx` is a
 * partial unique index over `(repo, issue) WHERE status IN ('queued','running','blocked')`, so a
 * non-terminal row for an issue that already has one is a claim violation. This row describes a run
 * that reached an outcome; the claim belongs to whatever live attempt holds it.
 */
export function buildAttemptSummary(input: {
  runId: string;
  repo: string;
  issue: number;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  startedAt?: string;
  iterationCount?: number;
  prUrl?: string;
}): RunSummary {
  return {
    runId: input.runId,
    repo: input.repo,
    issue: input.issue,
    status: input.status,
    stage: "terminal",
    createdAt: input.createdAt,
    updatedAt: input.completedAt ?? input.createdAt,
    attemptCount: 1,
    reviewCount: 0,
    iterationCount: input.iterationCount ?? 0,
    fixCycleCount: 0,
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
    ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }),
  };
}

/**
 * Whether a run must record itself, and why not when it must not (#681).
 *
 * `ledgerRecorded` alone is not enough, which is the gap the investigation exposed: a
 * `ConsoleRunHistoryStore` reports `recorded: true` for every write while persisting nothing. A run
 * whose store is the console would therefore record itself into a void and report success - the same
 * class of defect as an empty acceptance matrix reading as a clean result.
 *
 * The store's own id is the honest signal, and it is checked FIRST: writing to a store that cannot
 * persist is theatre, and the operator needs to hear that rather than receive a silent no-op. The
 * remaining rule fails closed - only an explicit `false` records, because an omitted flag is not a
 * claim that a run is missing, and guessing would write a second row against a live run's issue.
 */
export function attemptRecordingDecision(input: {
  storeId: string;
  ledgerRecorded?: boolean;
}): { record: boolean; reason?: string } {
  if (input.storeId === "console") {
    return {
      record: false,
      reason:
        "the run history is a console store, which persists nothing; set DF_RUN_HISTORY_DRIVER and " +
        "DF_RUN_HISTORY_DATABASE_URL",
    };
  }
  if (input.ledgerRecorded !== false) return { record: false };
  return { record: true };
}
