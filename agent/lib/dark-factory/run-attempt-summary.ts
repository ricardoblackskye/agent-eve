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
