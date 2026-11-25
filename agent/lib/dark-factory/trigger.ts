/**
 * Dark Factory — the kick-off trigger (#163).
 *
 * Mirrors `agent/lib/story-trigger.ts` deliberately: a payload type, env-overridable
 * defaults, a PURE decision unit-testable offline, and a terminal-label guard so a
 * re-applied label cannot start a second run. One trigger style in the repo, not two.
 *
 * TWO fail-closed gates, because a label alone is not authorisation: the repo must be
 * in `DF_WORKER_ALLOWED_REPOS` and the ACTOR (`sender.login`) in
 * `DF_TRIGGER_ALLOWED_USERS`. On a public repo anyone can apply a label, so without
 * the actor gate the trigger is forgeable. Unset or empty ⇒ REFUSE — the lesson from
 * #78, where an absent configuration was read as permission to relax the control.
 *
 * The decision carries a REASON rather than a boolean, because the outcomes differ to a
 * caller: `not-a-trigger` is a 200 fall-through ("nothing for us"), while `refused` is a
 * gate doing its job and must be visible.
 */
import { resolveWorkerAllowedRepos } from "./credentials";

/** The subset of a GitHub issue webhook payload this module reads. */
export interface DarkFactoryTriggerPayload {
  action: string;
  issue?: {
    number?: number;
    title?: string;
    body?: string;
    labels?: Array<{ name?: string }>;
  };
  label?: { name?: string };
  /**
   * Present on an `issue_comment` payload (#306): the human's reply to a parked
   * question. A comment is an ANSWER — never a fresh-run trigger.
   */
  comment?: { id?: number; body?: string };
  pull_request?: unknown;
  sender?: { login?: string };
  repository?: { full_name?: string };
}

export interface DarkFactoryTriggerDefaults {
  /** The label that requests work. */
  label: string;
}

export const TRIGGER_DEFAULTS: DarkFactoryTriggerDefaults = {
  label: "dark-factory",
};

/**
 * The label vocabulary. `df:*` is LIFECYCLE state; the question label is deliberately
 * NOT in that family because it is an instruction to a human ("answer me"), matching
 * the existing `needs-story` style — and one state must not have two labels.
 */
export const TRIGGER_LABELS = {
  running: "df:running",
  done: "df:done",
  // #672: a run that produced work but the Definition of Done did not certify.
  // Deliberately absent from TERMINAL_LABELS, so the ticket can be re-triggered.
  blocked: "df:blocked",
  failed: "df:failed",
  question: "needs-answer",
} as const;

/**
 * Labels that describe a FINISHED attempt. A re-trigger is refused for these and
 * no others (#672) - `df:blocked` is absent on purpose, because "produced work,
 * awaiting certification" is not finished, so re-applying the trigger label starts
 * another attempt instead of being refused.
 */
export const TERMINAL_LABELS: readonly string[] = [
  TRIGGER_LABELS.done,
  TRIGGER_LABELS.failed,
];

/**
 * Labels a NEW attempt must not inherit from a previous one (#373, #672).
 *
 * A SUPERSET of TERMINAL_LABELS, and the difference is load-bearing:
 * `df:blocked` is not terminal - a blocked ticket is re-triggerable, which is the
 * point of the outcome - but it IS a previous attempt's verdict. If it survived into
 * the next attempt the ticket would advertise `df:running` AND `df:blocked` at once,
 * which is exactly the contradictory pair #373 removed for `df:failed`.
 *
 * So: TERMINAL_LABELS decides whether a re-trigger is REFUSED; OUTCOME_LABELS decides
 * what a fresh start CLEARS. Do not collapse them.
 */
export const OUTCOME_LABELS: readonly string[] = [
  TRIGGER_LABELS.done,
  TRIGGER_LABELS.blocked,
  TRIGGER_LABELS.failed,
];

/**
 * Labels that make a ticket UN-TRIGGERABLE (#677). A strict subset of TERMINAL_LABELS, and
 * the difference is the whole point: `df:done` means the work is finished and must not
 * silently be redone, whereas `df:failed` describes a finished ATTEMPT whose ticket a human
 * may deliberately retry. The run-start clearing (#373, OUTCOME_LABELS) already removes the
 * stale label, so no other machinery is needed - re-applying the trigger label is enough.
 *
 * Three sets, and collapsing any two re-creates a defect already found: merging this with
 * TERMINAL_LABELS makes a crashed run impossible to retry; merging it with OUTCOME_LABELS leaves a
 * re-triggered ticket advertising df:running beside a stale outcome label.
 */
export const RETRIGGER_REFUSED_LABELS: readonly string[] = [
  TRIGGER_LABELS.done,
];

/** Bounds, so a hostile payload cannot produce an unbounded reason string. */
export const MAX_REASON_CHARS = 400;
const MAX_IDENTIFIER_CHARS = 120;

export function resolveTriggerLabel(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.DF_TRIGGER_LABEL?.trim() || TRIGGER_DEFAULTS.label;
}

/**
 * The actors permitted to request work, lowercased. Fail-closed: unset/blank ⇒ `[]`,
 * which refuses every sender rather than allowing every sender.
 */
export function resolveTriggerAllowedUsers(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = (env.DF_TRIGGER_ALLOWED_USERS ?? "").trim();
  if (raw === "") return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export type DarkFactoryTriggerKind =
  "trigger" | "abort" | "resume" | "not-a-trigger" | "refused";

export interface DarkFactoryTriggerDecision {
  kind: DarkFactoryTriggerKind;
  /** Human-readable and bounded; always explains the outcome. */
  reason: string;
  repo?: string;
  actor?: string;
  issue?: number;
  /**
   * The brief, when the decision is to start work. Bounded here so the entry point can
   * never render an unbounded blob, and passed as DATA — never as instructions.
   */
  issueTitle?: string;
  issueBody?: string;
  /**
   * The human's answer to a parked question (#306). Bounded here, and passed as DATA.
   */
  commentBody?: string;
}

/** Bounds on the free text carried from the issue into the handoff. */
export const MAX_BRIEF_TITLE_CHARS = 500;
export const MAX_BRIEF_BODY_CHARS = 2000;

/** Bound on the answer text carried from a comment into the resume handoff (#306). */
export const MAX_ANSWER_CHARS = 2000;

function clamp(value: string): string {
  return value.length > MAX_IDENTIFIER_CHARS
    ? `${value.slice(0, MAX_IDENTIFIER_CHARS)}...`
    : value;
}

function decide(
  kind: DarkFactoryTriggerKind,
  reason: string,
  extra: Partial<DarkFactoryTriggerDecision> = {},
): DarkFactoryTriggerDecision {
  const bounded =
    reason.length > MAX_REASON_CHARS
      ? `${reason.slice(0, MAX_REASON_CHARS)}...`
      : reason;
  return { kind, reason: bounded, ...extra };
}

/**
 * Decide what a GitHub issue event means for the Dark Factory.
 *
 * Order matters and is deliberate: a payload that is not about our labels at all is
 * `not-a-trigger` and is NEVER gated (the gates exist to authorise work, not to
 * comment on unrelated events), while anything that would start, abort or resume a run
 * is gated first.
 */
export function decideDarkFactoryTrigger(
  payload: DarkFactoryTriggerPayload,
  env: Record<string, string | undefined> = process.env,
): DarkFactoryTriggerDecision {
  const triggerLabel = resolveTriggerLabel(env).toLowerCase();
  const questionLabel = TRIGGER_LABELS.question.toLowerCase();

  // Never a run: pull requests, and terminal issue actions.
  if (payload.pull_request)
    return decide(
      "not-a-trigger",
      "pull request events are not dark-factory triggers",
    );
  const action = payload.action;
  if (action === "closed" || action === "deleted") {
    return decide(
      "not-a-trigger",
      `issue ${action} is a terminal event, not a dark-factory trigger`,
    );
  }

  const labelName = (payload.label?.name ?? "").trim().toLowerCase();
  const issueLabels = (payload.issue?.labels ?? [])
    .map((entry) => (entry?.name ?? "").trim().toLowerCase())
    .filter(Boolean);

  const isTriggerLabel = labelName === triggerLabel;
  const isQuestionLabel = labelName === questionLabel;

  // #306 — a comment answers a parked question. It can only ever RESUME, never start
  // fresh work. GitHub issue comments are FLAT (there is no thread id to match on), so
  // the answer is correlated by ISSUE plus arrival order; an unrelated comment is made
  // a no-op by the blocked-run requirement inside runDarkFactoryDispatch, not here.
  const comment = payload.comment;
  if (comment !== undefined && action !== "created") {
    return decide(
      "not-a-trigger",
      `'${clamp(action)}' comment events are not answers to a parked question`,
    );
  }

  if (comment === undefined) {
    if (action === "labeled" && !isTriggerLabel) {
      return decide(
        "not-a-trigger",
        `'${clamp(labelName || "(none)")}' is not a dark-factory trigger label`,
      );
    }
    if (action === "unlabeled" && !isTriggerLabel && !isQuestionLabel) {
      return decide(
        "not-a-trigger",
        `'${clamp(labelName || "(none)")}' is not a dark-factory label`,
      );
    }
    if (action !== "labeled" && action !== "unlabeled") {
      return decide(
        "not-a-trigger",
        `'${action}' is not a dark-factory trigger action`,
      );
    }
  }

  // A ticket whose work is FINISHED must not be started again (#677). This is deliberately
  // narrower than "terminal": a crashed run's `df:failed` is terminal for the ATTEMPT, but its
  // ticket is meant to be retryable - the run-start clearing (#373) drops the stale label, so
  // re-applying the trigger label is a deliberate retry rather than a duplicate run.
  for (const refused of RETRIGGER_REFUSED_LABELS) {
    if (issueLabels.includes(refused)) {
      return decide(
        "not-a-trigger",
        `the run already reached '${refused}'; not starting or changing it`,
      );
    }
  }

  // --- Authorisation: BOTH gates, fail-closed, before anything is allowed to happen ---
  const repo = (payload.repository?.full_name ?? "").trim().toLowerCase();
  const actor = (payload.sender?.login ?? "").trim().toLowerCase();
  const allowedRepos = resolveWorkerAllowedRepos(env);
  const allowedUsers = resolveTriggerAllowedUsers(env);

  if (allowedRepos.length === 0) {
    return decide(
      "refused",
      "DF_WORKER_ALLOWED_REPOS is not configured; refusing to dispatch (fail-closed).",
    );
  }
  if (!allowedRepos.includes(repo)) {
    return decide(
      "refused",
      `repo '${clamp(repo || "(none)")}' is not in DF_WORKER_ALLOWED_REPOS.`,
    );
  }
  if (allowedUsers.length === 0) {
    return decide(
      "refused",
      "DF_TRIGGER_ALLOWED_USERS is not configured; refusing to dispatch (fail-closed).",
    );
  }
  if (!allowedUsers.includes(actor)) {
    return decide(
      "refused",
      `sender '${clamp(actor || "(none)")}' is not in DF_TRIGGER_ALLOWED_USERS.`,
    );
  }

  const issue = Number.isInteger(payload.issue?.number)
    ? (payload.issue?.number as number)
    : undefined;
  if (issue === undefined) {
    return decide(
      "refused",
      "the payload carries no usable issue number, so no run can be recorded.",
    );
  }

  const where = {
    repo,
    actor,
    issue,
    issueTitle: (payload.issue?.title ?? "").slice(0, MAX_BRIEF_TITLE_CHARS),
    issueBody: (payload.issue?.body ?? "").slice(0, MAX_BRIEF_BODY_CHARS),
  };
  if (comment !== undefined) {
    return decide(
      "resume",
      `a comment answer on ${clamp(repo)}#${issue} resumes the parked run`,
      {
        ...where,
        commentBody: (comment.body ?? "").slice(0, MAX_ANSWER_CHARS),
      },
    );
  }
  if (action === "labeled") {
    return decide(
      "trigger",
      `'${clamp(labelName)}' requested dark-factory work on ${clamp(repo)}#${issue}`,
      where,
    );
  }
  if (labelName === questionLabel) {
    // #309 — the label-clear resume path is RETIRED. The comment reply is now the only
    // resume path (see ADR 0064, which supersedes ADR 0022). Clearing the label is a
    // no-op, not a resume, so an operator who removes it cannot accidentally restart a
    // run through an undocumented action.
    return decide(
      "not-a-trigger",
      `the '${clamp(questionLabel)}' label was cleared on ${clamp(repo)}#${issue}, but the label-clear resume path is retired (#309); reply on the issue to resume a parked run`,
    );
  }
  return decide(
    "abort",
    `the trigger label was removed on ${clamp(repo)}#${issue}; aborting the run`,
    where,
  );
}

/**
 * #759: which label instructs a HUMAN, if any.
 *
 * Two states ask a person for something and they are NOT the same request: a parked plan wants
 * permission to start, and a delivered result wants sign-off. Collapsing them into `needs-answer` made
 * a finished issue read as unfinished.
 *
 * `awaiting-signoff` is deliberately NOT in the `df:*` family: that family is lifecycle state, while this
 * is an instruction to a human - the same reason `needs-answer` sits outside it. It rides BESIDE
 * `df:done`, and neither is cleared by a fresh dispatch.
 */
export type HumanState = "awaiting-signoff" | "needs-answer";

export interface HumanStateInput {
  /** A plan is parked, so the factory needs permission to start coding. */
  planParked: boolean;
  /** The Definition of Done passed. */
  dodPassed: boolean;
  /** A pull request exists for the run branch. */
  pullRequestOpen: boolean;
}

export function selectHumanStateLabel(input: HumanStateInput): HumanState | null {
  // A parked plan wins: the factory cannot start without an answer, so that is the request in flight.
  if (input.planParked) return "needs-answer";

  // Delivered work, with something to sign off. Without a pull request there is nothing to sign, and the
  // Definition of Done s own verdict already says the work is finished - so no human label is warranted.
  if (input.dodPassed && input.pullRequestOpen) return "awaiting-signoff";

  return null;
}
