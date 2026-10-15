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

/** Not implemented yet (RED stub for #365 R4 Task 2). */
export async function parkForApproval(
  _deps: PlanApprovalDeps,
  _options: ParkForApprovalOptions,
): Promise<ParkResult> {
  throw new Error("parkForApproval is not implemented");
}
