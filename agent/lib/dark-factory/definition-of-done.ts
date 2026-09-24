/**
 * Dark Factory — Definition of DONE (#164).
 *
 * A task is done only when all of these hold:
 * 1. A PR is opened on a task branch, linked to the issue (`Closes #<issue>`).
 * 2. Every automated finding is dispositioned (resolved via code change, or
 *    explicitly accepted with a reasoned explanation posted on the PR).
 * 3. The loop is bounded (`DF_MAX_REVIEW_ROUNDS`, digits-only, default 3).
 *    Recurring findings count against the budget (no reset).
 *    On exhaustion the task stops and becomes `df:blocked` / `needs-answer`.
 * 4. The factory MUST NEVER MERGE — opening the PR is the terminal action.
 */

import type {
  CreatePullRequestOptions,
  CreatePullRequestResult,
  PullRequestDetails,
} from "./pr-writer";
import type { ExecutionPlan } from "./plan-validator";
import { toRunEvent, type RunEvent } from "./run-history";
import type { EventCursor, RunHistoryStore } from "./run-history-store";

export class InvalidConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfigurationError";
  }
}

export const DEFAULT_MAX_REVIEW_ROUNDS = 3;

/**
 * Resolve the maximum review rounds allowed.
 * Enforces digits-only validation (matching DF_MAX_ITERATIONS).
 * Fail-closed: invalid input throws InvalidConfigurationError.
 */
export function resolveMaxReviewRounds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.DF_MAX_REVIEW_ROUNDS?.trim();
  if (!raw) return DEFAULT_MAX_REVIEW_ROUNDS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new InvalidConfigurationError(
      `DF_MAX_REVIEW_ROUNDS must be a positive integer (digits only, received '${raw}').`,
    );
  }
  return Number(raw);
}

export type FindingSource = "pr-reviewer" | "codeql" | "linter" | "test";
export type FindingDispositionStatus = "resolved" | "accepted";

export interface ReviewFinding {
  id: string;
  source: FindingSource;
  message: string;
  file?: string;
  line?: number;
  severity?: "error" | "warning" | "note";
}

export interface FindingDisposition {
  findingId: string;
  status: FindingDispositionStatus;
  explanation?: string; // Required when status === "accepted"
}

export interface DefinitionOfDoneTask {
  runId: string;
  repo: string; // "owner/repo"
  issue: number;
  head: string; // task branch
  base?: string; // default "main"
  title: string;
  body: string;
  plan?: ExecutionPlan;
  testResults?: { testFile: string; testCaseName: string; passed: boolean }[];
  /** Only provide metrics observed by the caller; omitted values stay unmeasured. */
  runMetrics?: Pick<RunEvent, "iterationCount" | "fixCycleCount" | "latencyMs" | "costUsd">;
}

export interface PrCommentWriter {
  postComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface PrOpener {
  createPullRequest(
    owner: string,
    repo: string,
    options: CreatePullRequestOptions,
  ): Promise<CreatePullRequestResult>;
}

export interface LabelWriter {
  add(
    repo: string,
    issue: number,
    label: string,
  ): Promise<{ ok: boolean; error?: string }>;
  remove(
    repo: string,
    issue: number,
    label: string,
  ): Promise<{ ok: boolean; error?: string }>;
}

export interface DefinitionOfDoneDeps {
  prWriter: PrOpener;
  commentWriter: PrCommentWriter;
  labelWriter?: LabelWriter;
  env?: Record<string, string | undefined>;
  runChecks: (round: number) => Promise<ReviewFinding[]>;
  attemptFixes?: (findings: ReviewFinding[]) => Promise<FindingDisposition[]>;
  runHistory?: RunHistoryStore;
}

import {
  renderAcTraceabilityTable,
  renderAcceptedFindingComment,
  type AcTraceabilityItem,
} from "./dod-presentation";

export {
  renderAcTraceabilityTable,
  renderAcceptedFindingComment,
  type AcTraceabilityItem,
} from "./dod-presentation";

export type DoneStatus = "done" | "blocked" | "refused";

export interface DefinitionOfDoneResult {
  ok: boolean;
  status: DoneStatus;
  pr?: PullRequestDetails;
  roundsExecuted: number;
  totalFindings: number;
  resolvedCount: number;
  acceptedCount: number;
  remainingFindings: ReviewFinding[];
  reason: string;
  acMatrix?: AcTraceabilityItem[];
  traceabilityTable?: string;
}

export interface AcTestResult {
  testFile: string;
  testCaseName: string;
  passed: boolean;
}

export interface AcVerificationResult {
  matrix: AcTraceabilityItem[];
  allPassed: boolean;
  failingAcs: AcTraceabilityItem[];
}

/**
 * Validates test results against the Acceptance Criteria mappings in an ExecutionPlan.
 * Pure evaluation component separated from markdown rendering (SRP).
 */
export function evaluateAcTraceability(
  plan: ExecutionPlan,
  testResults: AcTestResult[] = [],
): AcVerificationResult {
  const mappings = plan.acceptanceCriteriaMap ?? [];
  const matrix: AcTraceabilityItem[] = mappings.map((ac) => {
    const match = testResults.find(
      (tr) =>
        tr.testFile === ac.testFile &&
        (tr.testCaseName === ac.testCaseName ||
          tr.testCaseName.includes(ac.testCaseName) ||
          ac.testCaseName.includes(tr.testCaseName)),
    );
    return {
      acId: ac.acId,
      description: ac.description,
      testFile: ac.testFile,
      testCaseName: ac.testCaseName,
      passed: match ? match.passed : false,
    };
  });

  const failingAcs = matrix.filter((item) => !item.passed);
  return {
    matrix,
    allPassed: failingAcs.length === 0,
    failingAcs,
  };
}


function buildSuccessResult(
  pr: PullRequestDetails,
  roundsExecuted: number,
  totalDistinctFindings: number,
  acceptedCount: number,
  acMatrix?: AcTraceabilityItem[],
  traceabilityTable?: string,
): DefinitionOfDoneResult {
  return {
    ok: true,
    status: "done",
    pr,
    roundsExecuted,
    totalFindings: totalDistinctFindings,
    resolvedCount: totalDistinctFindings - acceptedCount,
    acceptedCount,
    remainingFindings: [],
    reason: "All automated review findings resolved or accepted.",
    acMatrix,
    traceabilityTable,
  };
}

function buildBudgetExhaustedResult(
  pr: PullRequestDetails,
  maxRounds: number,
  roundsExecuted: number,
  totalDistinctFindings: number,
  acceptedCount: number,
  remaining: ReviewFinding[],
): DefinitionOfDoneResult {
  return {
    ok: false,
    status: "blocked",
    pr,
    roundsExecuted,
    totalFindings: totalDistinctFindings,
    resolvedCount: totalDistinctFindings - acceptedCount - remaining.length,
    acceptedCount,
    remainingFindings: remaining,
    reason: `Review budget exhausted (${maxRounds} rounds) with ${remaining.length} unresolved finding(s).`,
  };
}

interface DispositionOutcome {
  blockedResult?: DefinitionOfDoneResult;
}

async function applyAcceptedDispositions(
  deps: DefinitionOfDoneDeps,
  task: DefinitionOfDoneTask,
  owner: string,
  repoName: string,
  pr: PullRequestDetails,
  unacceptedFindings: ReviewFinding[],
  dispositions: FindingDisposition[],
  acceptedIds: Set<string>,
  state: {
    roundsExecuted: number;
    totalDistinctFindings: number;
  },
): Promise<DispositionOutcome> {
  const errorFindings: ReviewFinding[] = [];
  const validDispositions: { finding: ReviewFinding; explanation: string }[] = [];

  for (const disposition of dispositions) {
    if (disposition.status === "accepted") {
      const explanation = (disposition.explanation ?? "").trim();
      if (!explanation) {
        if (deps.labelWriter) {
          await deps.labelWriter.add(task.repo, task.issue, "needs-answer");
        }
        return {
          blockedResult: {
            ok: false,
            status: "blocked",
            pr,
            roundsExecuted: state.roundsExecuted,
            totalFindings: state.totalDistinctFindings,
            resolvedCount: state.totalDistinctFindings - acceptedIds.size,
            acceptedCount: acceptedIds.size,
            remainingFindings: unacceptedFindings,
            reason: `Finding '${disposition.findingId}' was marked accepted but requires a non-empty explanation.`,
          },
        };
      }

      const finding = unacceptedFindings.find(
        (f) => f.id === disposition.findingId,
      );
      if (!finding) {
        continue;
      }
      if (finding.severity === "error") {
        errorFindings.push(finding);
      } else {
        validDispositions.push({ finding, explanation });
      }
    }
  }

  if (errorFindings.length > 0) {
    const errSummary = errorFindings
      .map((f) => `${f.id}: ${f.message}`)
      .join("; ");
    return {
      blockedResult: {
        ok: false,
        status: "blocked",
        pr,
        roundsExecuted: state.roundsExecuted,
        totalFindings: state.totalDistinctFindings,
        resolvedCount: state.totalDistinctFindings - acceptedIds.size,
        acceptedCount: acceptedIds.size,
        remainingFindings: unacceptedFindings,
        reason: `Definition of Done cannot accept findings with severity 'error' (${errSummary}).`,
      },
    };
  }

  for (const { finding, explanation } of validDispositions) {
    let posted: { ok: boolean; error?: string };
    try {
      posted = await deps.commentWriter.postComment(
        owner,
        repoName,
        pr.number,
        renderAcceptedFindingComment(finding, explanation),
      );
    } catch (error) {
      posted = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!posted.ok) {
      if (deps.labelWriter) {
        await deps.labelWriter.add(task.repo, task.issue, "needs-answer");
      }
      return {
        blockedResult: {
          ok: false,
          status: "blocked",
          pr,
          roundsExecuted: state.roundsExecuted,
          totalFindings: state.totalDistinctFindings,
          resolvedCount: state.totalDistinctFindings - acceptedIds.size,
          acceptedCount: acceptedIds.size,
          remainingFindings: unacceptedFindings,
          reason: "An accepted finding was not persisted to the PR comment; the run is blocked.",
        },
      };
    }
    acceptedIds.add(finding.id);
  }
  return {};
}

/**
 * Run the Definition of DONE loop.
 *
 * Coordinates:
 * 1. Opening the PR linked to the issue (`Closes #<issue>`).
 * 2. Iterating review checks up to DF_MAX_REVIEW_ROUNDS (1-indexed inclusive: [1..maxRounds]).
 * 3. Handling recurring findings (count against budget without reset).
 * 4. Dispositioning findings (resolved vs. accepted with durable PR comment).
 * 5. Halting on exhaustion with `df:blocked` / `needs-answer`.
 * 6. Guaranteeing no merge operation ever occurs.
 */
async function persistDODRunEvent(
  store: RunHistoryStore,
  input: Omit<RunEvent, "occurredAt">,
): Promise<{ ok: boolean; error?: string }> {
  try {
    let cursor: EventCursor | undefined;
    let existing: RunEvent | undefined;
    do {
      const page = await store.listRunEvents(input.runId, {
        limit: 100,
        ...(cursor ? { after: cursor } : {}),
      });
      if (!page.ok || !page.value) {
        return {
          ok: false,
          error: page.error ?? "Run history could not read existing events.",
        };
      }
      existing = page.value.items.find(({ event }) => event.eventId === input.eventId)?.event;
      cursor = page.value.nextCursor;
    } while (!existing && cursor);

    const event = toRunEvent({
      ...input,
      occurredAt: existing?.occurredAt ?? new Date().toISOString(),
    });
    const result = await store.appendEvent(event);
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.error ?? "Run history rejected the event." };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runDefinitionOfDone(
  deps: DefinitionOfDoneDeps,
  task: DefinitionOfDoneTask,
): Promise<DefinitionOfDoneResult> {
  const env = deps.env ?? process.env;
  const maxRounds = resolveMaxReviewRounds(env);
  const [owner, repoName] = task.repo.split("/");
  const record = async (
    event: Omit<RunEvent, "occurredAt">,
  ): Promise<string | undefined> => {
    if (!deps.runHistory) return undefined;
    const result = await persistDODRunEvent(deps.runHistory, event);
    return result.ok ? undefined : result.error ?? "unknown storage error";
  };
  const blockedByHistory = (
    result: DefinitionOfDoneResult,
    error: string,
  ): DefinitionOfDoneResult => ({
    ...result,
    ok: false,
    status: "blocked",
    reason: `Run history persistence failed: ${error}`,
  });

  // 1. Open the PR linked to the issue
  const prResult = await deps.prWriter.createPullRequest(owner, repoName, {
    title: task.title,
    head: task.head,
    base: task.base || "main",
    body: task.body,
    issue: task.issue,
  });

  if (!prResult.ok || !prResult.pr) {
    const refused: DefinitionOfDoneResult = {
      ok: false,
      status: "refused",
      roundsExecuted: 0,
      totalFindings: 0,
      resolvedCount: 0,
      acceptedCount: 0,
      remainingFindings: [],
      reason: prResult.error ?? "Failed to open pull request.",
    };
    const historyError = await record({
      eventId: `dod:${task.runId}:terminal`,
      runId: task.runId,
      type: "run.terminal",
      stage: "terminal",
      status: "failed",
      ...task.runMetrics,
    });
    return historyError ? blockedByHistory(refused, historyError) : refused;
  }

  const pr = prResult.pr;
  const openedError = await record({
    eventId: `dod:${task.runId}:pr-opened`,
    runId: task.runId,
    type: "pr.opened",
    stage: "pull-request",
    status: "running",
    prUrl: pr.url,
  });
  if (openedError) {
    return blockedByHistory({
      ok: false,
      status: "blocked",
      pr,
      roundsExecuted: 0,
      totalFindings: 0,
      resolvedCount: 0,
      acceptedCount: 0,
      remainingFindings: [],
      reason: openedError,
    }, openedError);
  }

  // 1b. Verify Acceptance Criteria if task has an ExecutionPlan
  let acMatrix: AcTraceabilityItem[] | undefined;
  let traceabilityTable: string | undefined;

  if (
    task.plan?.acceptanceCriteriaMap &&
    task.plan.acceptanceCriteriaMap.length > 0
  ) {
    const verification = evaluateAcTraceability(
      task.plan,
      task.testResults ?? [],
    );
    acMatrix = verification.matrix;
    traceabilityTable = renderAcTraceabilityTable(acMatrix);

    if (!verification.allPassed) {
      await deps.commentWriter.postComment(
        owner,
        repoName,
        pr.number,
        `🤖 **Eve** (Dark Factory) — Acceptance Criteria Verification Failed\n\n${traceabilityTable}`,
      );
      const blocked: DefinitionOfDoneResult = {
        ok: false,
        status: "blocked",
        pr,
        roundsExecuted: 0,
        totalFindings: 0,
        resolvedCount: 0,
        acceptedCount: 0,
        remainingFindings: [],
        reason: `Acceptance Criteria verification failed: AC(s) ${verification.failingAcs.map((a) => a.acId).join(", ")} did not pass tests.`,
        acMatrix,
        traceabilityTable,
      };
      const historyError = await record({
        eventId: `dod:${task.runId}:ac-criteria-blocked`,
        runId: task.runId,
        type: "review.round",
        stage: "review",
        status: "blocked",
        reviewRound: 1,
      });
      return historyError ? blockedByHistory(blocked, historyError) : blocked;
    }

    // Post verified table to PR
    await deps.commentWriter.postComment(
      owner,
      repoName,
      pr.number,
      `🤖 **Eve** (Dark Factory) — Acceptance Criteria Verified ✅\n\n${traceabilityTable}`,
    );
  }

  const recurrenceMap = new Map<string, number>();
  const acceptedIds = new Set<string>();
  let previousActiveFindingIds = new Set<string>();
  let totalDistinctFindings = 0;
  let roundsExecuted = 0;

  const recordReviewRound = async (
    round: number,
    status: "running" | "blocked",
    counts: { findingCount: number; resolvedCount: number; acceptedCount: number },
  ): Promise<string | undefined> => record({
    eventId: `dod:${task.runId}:review:${round}`,
    runId: task.runId,
    type: "review.round",
    stage: "review",
    status,
    reviewRound: round,
    ...counts,
    ...task.runMetrics,
  });

  const completeSuccessfully = async (
    result: DefinitionOfDoneResult,
    round: number,
    counts: { findingCount: number; resolvedCount: number; acceptedCount: number },
  ): Promise<DefinitionOfDoneResult> => {
    const reviewError = await recordReviewRound(round, "running", counts);
    if (reviewError) return blockedByHistory(result, reviewError);
    const terminalError = await record({
      eventId: `dod:${task.runId}:terminal`,
      runId: task.runId,
      type: "run.terminal",
      stage: "terminal",
      status: "succeeded",
      reviewRound: round,
      prUrl: pr.url,
      ...task.runMetrics,
    });
    return terminalError ? blockedByHistory(result, terminalError) : result;
  };

  // 2. Review and fix loop.
  // Iterates round from 1 to maxRounds inclusive [1..maxRounds], executing
  // exactly maxRounds iterations (e.g. 1, 2, 3 for maxRounds = 3).
  for (let round = 1; round <= maxRounds; round++) {
    roundsExecuted = round;
    const findings = await deps.runChecks(round);

    // Filter out findings already accepted in earlier rounds
    const unacceptedFindings = findings.filter((f) => !acceptedIds.has(f.id));
    const activeFindingIds = new Set(unacceptedFindings.map((finding) => finding.id));
    const roundCounts = {
      findingCount: activeFindingIds.size,
      resolvedCount: [...previousActiveFindingIds].filter(
        (id) => !activeFindingIds.has(id) && !acceptedIds.has(id),
      ).length,
      acceptedCount: 0,
    };

    // Track distinct findings and recurrence.
    for (const f of unacceptedFindings) {
      const prev = recurrenceMap.get(f.id) ?? 0;
      if (prev === 0) {
        totalDistinctFindings += 1;
      }
      recurrenceMap.set(f.id, prev + 1);
    }

    // If no active findings remain, the task is DONE!
    if (unacceptedFindings.length === 0) {
      return completeSuccessfully(
        buildSuccessResult(
          pr,
          roundsExecuted,
          totalDistinctFindings,
          acceptedIds.size,
          acMatrix,
          traceabilityTable,
        ),
        round,
        roundCounts,
      );
    }

    // Attempt fixes or acceptance dispositions
    if (deps.attemptFixes) {
      const dispositions = await deps.attemptFixes(unacceptedFindings);
      const acceptedBeforeRound = acceptedIds.size;

      const outcome = await applyAcceptedDispositions(
        deps,
        task,
        owner,
        repoName,
        pr,
        unacceptedFindings,
        dispositions,
        acceptedIds,
        { roundsExecuted, totalDistinctFindings },
      );
      roundCounts.acceptedCount = acceptedIds.size - acceptedBeforeRound;

      if (outcome.blockedResult) {
        const historyError = await recordReviewRound(round, "blocked", roundCounts);
        return historyError
          ? blockedByHistory(outcome.blockedResult, historyError)
          : outcome.blockedResult;
      }

      // Check if all findings are now accepted
      const remainingAfterDispositions = unacceptedFindings.filter(
        (f) => !acceptedIds.has(f.id),
      );
      if (remainingAfterDispositions.length === 0) {
        return completeSuccessfully(
          buildSuccessResult(
            pr,
            roundsExecuted,
            totalDistinctFindings,
            acceptedIds.size,
            acMatrix,
            traceabilityTable,
          ),
          round,
          roundCounts,
        );
      }
    }

    // If this was the last round and unaccepted findings still remain, budget exhausted
    if (round === maxRounds) {
      const remaining = unacceptedFindings.filter(
        (f) => !acceptedIds.has(f.id),
      );
      if (deps.labelWriter) {
        await deps.labelWriter.add(task.repo, task.issue, "needs-answer");
      }
      const blocked: DefinitionOfDoneResult = buildBudgetExhaustedResult(
        pr,
        maxRounds,
        roundsExecuted,
        totalDistinctFindings,
        acceptedIds.size,
        remaining,
      );
      const historyError = await recordReviewRound(round, "blocked", roundCounts);
      return historyError ? blockedByHistory(blocked, historyError) : blocked;
    }

    previousActiveFindingIds = new Set(
      unacceptedFindings
        .filter((finding) => !acceptedIds.has(finding.id))
        .map((finding) => finding.id),
    );
    const historyError = await recordReviewRound(round, "running", roundCounts);
    if (historyError) {
      return blockedByHistory({
        ok: false,
        status: "blocked",
        pr,
        roundsExecuted,
        totalFindings: totalDistinctFindings,
        resolvedCount: totalDistinctFindings - acceptedIds.size,
        acceptedCount: acceptedIds.size,
        remainingFindings: unacceptedFindings.filter((f) => !acceptedIds.has(f.id)),
        reason: historyError,
      }, historyError);
    }
  }

  return {
    ok: false,
    status: "blocked",
    pr,
    roundsExecuted,
    totalFindings: totalDistinctFindings,
    resolvedCount: totalDistinctFindings - acceptedIds.size,
    acceptedCount: acceptedIds.size,
    remainingFindings: [],
    reason: "Review loop terminated unexpectedly.",
  };
}
