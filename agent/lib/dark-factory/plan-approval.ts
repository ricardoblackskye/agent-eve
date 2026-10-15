/**
 * Dark Factory — the plan approval gate (#365 R4).
 *
 * R3 made the run post its plan on the ticket before coding. This is the other half: the run then STOPS and
 * waits for a human to approve that plan, instead of coding immediately.
 *
 * The machinery already existed on both sides and was never joined up:
 * - the park side: `worker-reporter.ts` renders "blocked on a human decision", and `run-history.ts` derives
 *   the run's status from a `worker.question` event, requiring it to be `blocked`;
 * - the resume side: `trigger.ts` decodes a comment answer, or a cleared `needs-answer` label, as a resume,
 *   and `entry.ts` refuses to resume unless an active run is `blocked`.
 *
 * This module is the park half's entry point.
 */

import {
  findPlanComment,
  parsePlanFromComment,
  type PlanCommentRecord,
} from "./plan-comment";

/** What the human is asked. One place, so the ticket and the tests agree on the wording. */
export const PLAN_APPROVAL_QUESTION =
  "Approve this plan and I will start coding. Reply on this issue, or remove the `needs-answer` label, to " +
  "begin. The run will not consume further iterations while it waits.";

/**
 * Stable for a run, so a re-delivery records the SAME question event rather than parking a second time.
 * The ledger keys events by id; a fresh id per attempt would stack duplicate questions on the ticket.
 */
export function planApprovalEventId(runId: string): string {
  return `${runId}:plan-approval`;
}

/** The worker report shape this needs, structurally, so it can be tested without a reporter. */
export interface PlanApprovalReporter {
  report(message: {
    kind: "question";
    runId: string;
    repo: string;
    issue: number;
    eventId?: string;
    occurredAt?: string;
    question?: string;
  }): Promise<{
    ok: boolean;
    mode: "live" | "dry-run" | "blocked";
    commentUrl?: string;
    error?: string;
  }>;
}

/** The label writer, structurally. */
export interface PlanApprovalLabels {
  add(repo: string, issue: number, label: string): Promise<{ ok: boolean; error?: string }>;
}

export interface PlanApprovalDeps {
  reporter: PlanApprovalReporter;
  labels: PlanApprovalLabels;
}

export interface ParkForApprovalOptions {
  runId: string;
  repo: string;
  issue: number;
  /** The label that marks a run as waiting for a human, e.g. `needs-answer`. */
  questionLabel: string;
  occurredAt?: string;
}

export type ParkResult =
  | { ok: true; mode: string; commentUrl?: string; labelApplied: boolean; warning?: string }
  | { ok: false; error: string };

/**
 * Park the run and ask a human to approve the plan.
 *
 * The question is recorded FIRST, because recording it IS the park: run-history derives the run's status
 * from a `worker.question`, which is what the resume path later looks for. Doing it in this order also
 * means a label outage cannot hide the question behind a failed write.
 */
export async function parkForApproval(
  deps: PlanApprovalDeps,
  options: ParkForApprovalOptions,
): Promise<ParkResult> {
  const reported = await deps.reporter.report({
    kind: "question",
    runId: options.runId,
    repo: options.repo,
    issue: options.issue,
    eventId: planApprovalEventId(options.runId),
    occurredAt: options.occurredAt,
    question: PLAN_APPROVAL_QUESTION,
  });

  if (!reported.ok) {
    // Fail closed: nothing was parked, so the caller must NOT fall through into coding.
    return {
      ok: false,
      error: `the run could not be parked: ${reported.error ?? "the question was not recorded"}`,
    };
  }

  const labelled = await deps.labels.add(
    options.repo,
    options.issue,
    options.questionLabel,
  );
  if (!labelled.ok) {
    // Still parked. A failure here would contradict the ledger, which now says blocked, so this is a
    // warning rather than an error - and a human can still reply on the ticket to resume.
    return {
      ok: true,
      mode: reported.mode,
      commentUrl: reported.commentUrl,
      labelApplied: false,
      warning: `the run is parked but '${options.questionLabel}' could not be applied: ${
        labelled.error ?? "unknown error"
      }`,
    };
  }

  return {
    ok: true,
    mode: reported.mode,
    commentUrl: reported.commentUrl,
    labelApplied: true,
  };
}

/**
 * The human-facing reason a run stopped at planning, written for the ticket rather than the log.
 *
 * A resume that cannot read its plan needs a different story from a fresh run whose planning failed: on a
 * resume nobody planned, so "Architect Agent planning failed" sends a reader looking in the wrong place -
 * when the real answer is that a fresh plan would not be the plan they approved.
 */
export function explainPlanFailure(
  error: string,
  options: { resuming: boolean },
): string {
  return options.resuming
    ? "This resumed run could not read back the plan it was approved against, so it stopped rather than " +
        "plan again: a fresh plan would not be the one that was approved.\n\n" + error
    : `Planning failed, so this run stopped before writing any code.\n\n${error}`;
}

/** The ticket reader this needs, structurally, so it can be tested without any network. */
export interface ApprovedPlanDeps {
  listComments(
    owner: string,
    repo: string,
    issue: number,
  ): Promise<{ ok: boolean; comments?: PlanCommentRecord[]; error?: string }>;
}

export type ApprovedPlanResult =
  | { ok: true; plan: unknown }
  | { ok: false; error: string };

/**
 * Read the plan a human approved back off the ticket.
 *
 * Fails closed at every step. Re-planning on a resume would be the worst outcome available: it would code
 * against a plan no human ever read, while appearing to honour the approval that was given.
 */
export async function loadApprovedPlan(
  deps: ApprovedPlanDeps,
  options: { owner: string; repo: string; issue: number },
): Promise<ApprovedPlanResult> {
  const listed = await deps.listComments(options.owner, options.repo, options.issue);
  if (!listed.ok) {
    return {
      ok: false,
      error: `the approved plan could not be read from the ticket: ${listed.error ?? "unknown error"}`,
    };
  }

  const comment = findPlanComment(listed.comments ?? []);
  if (!comment || typeof comment.body !== "string" || comment.body === "") {
    return { ok: false, error: "there is no approved plan on this ticket to resume from" };
  }

  const parsed = parsePlanFromComment(comment.body);
  if (!parsed.ok) {
    return { ok: false, error: `the approved plan could not be read: ${parsed.error}` };
  }
  return { ok: true, plan: parsed.plan };
}
