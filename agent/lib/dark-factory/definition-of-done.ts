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
}

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
}

/**
 * Render a structured, durable PR comment for an accepted finding.
 * Attributed to Eve (orchestrator), preserving reasoning for the human reviewer.
 */
export function renderAcceptedFindingComment(
  finding: ReviewFinding,
  explanation: string,
): string {
  const location =
    finding.file && finding.line
      ? ` (\`${finding.file}#${finding.line}\`)`
      : finding.file
        ? ` (\`${finding.file}\`)`
        : "";

  return [
    "🤖 **Eve** (Dark Factory) — Finding Accepted",
    "",
    `- **Finding ID**: \`${finding.id}\``,
    `- **Source**: \`${finding.source}\`${location}`,
    `- **Finding**: ${finding.message}`,
    `- **Disposition**: Accepted by Developer Agent`,
    `- **Rationale**:`,
    `  > ${explanation.trim()}`,
    "",
    "_Note: The human reviewer retains final call at merge time._",
  ].join("\n");
}

function buildSuccessResult(
  pr: PullRequestDetails,
  roundsExecuted: number,
  totalDistinctFindings: number,
  acceptedCount: number,
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
      if (finding) {
        await deps.commentWriter.postComment(
          owner,
          repoName,
          pr.number,
          renderAcceptedFindingComment(finding, explanation),
        );
        acceptedIds.add(disposition.findingId);
      }
    }
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
export async function runDefinitionOfDone(
  deps: DefinitionOfDoneDeps,
  task: DefinitionOfDoneTask,
): Promise<DefinitionOfDoneResult> {
  const env = deps.env ?? process.env;
  const maxRounds = resolveMaxReviewRounds(env);
  const [owner, repoName] = task.repo.split("/");

  // 1. Open the PR linked to the issue
  const prResult = await deps.prWriter.createPullRequest(owner, repoName, {
    title: task.title,
    head: task.head,
    base: task.base || "main",
    body: task.body,
    issue: task.issue,
  });

  if (!prResult.ok || !prResult.pr) {
    return {
      ok: false,
      status: "refused",
      roundsExecuted: 0,
      totalFindings: 0,
      resolvedCount: 0,
      acceptedCount: 0,
      remainingFindings: [],
      reason: prResult.error ?? "Failed to open pull request.",
    };
  }

  const pr = prResult.pr;
  const recurrenceMap = new Map<string, number>();
  const acceptedIds = new Set<string>();
  let totalDistinctFindings = 0;
  let roundsExecuted = 0;

  // 2. Review and fix loop.
  // Iterates round from 1 to maxRounds inclusive [1..maxRounds], executing
  // exactly maxRounds iterations (e.g. 1, 2, 3 for maxRounds = 3).
  for (let round = 1; round <= maxRounds; round++) {
    roundsExecuted = round;
    const findings = await deps.runChecks(round);

    // Filter out findings already accepted in earlier rounds
    const unacceptedFindings = findings.filter((f) => !acceptedIds.has(f.id));

    // Track distinct findings and recurrence
    for (const f of unacceptedFindings) {
      const prev = recurrenceMap.get(f.id) ?? 0;
      if (prev === 0) {
        totalDistinctFindings += 1;
      }
      recurrenceMap.set(f.id, prev + 1);
    }

    // If no active findings remain, the task is DONE!
    if (unacceptedFindings.length === 0) {
      return buildSuccessResult(
        pr,
        roundsExecuted,
        totalDistinctFindings,
        acceptedIds.size,
      );
    }

    // Attempt fixes or acceptance dispositions
    if (deps.attemptFixes) {
      const dispositions = await deps.attemptFixes(unacceptedFindings);

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

      if (outcome.blockedResult) {
        return outcome.blockedResult;
      }

      // Check if all findings are now accepted
      const remainingAfterDispositions = unacceptedFindings.filter(
        (f) => !acceptedIds.has(f.id),
      );
      if (remainingAfterDispositions.length === 0) {
        return buildSuccessResult(
          pr,
          roundsExecuted,
          totalDistinctFindings,
          acceptedIds.size,
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
      return buildBudgetExhaustedResult(
        pr,
        maxRounds,
        roundsExecuted,
        totalDistinctFindings,
        acceptedIds.size,
        remaining,
      );
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
