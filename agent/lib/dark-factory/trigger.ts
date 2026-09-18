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
  failed: "df:failed",
  question: "needs-answer",
} as const;

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
}

/** Bounds on the free text carried from the issue into the handoff. */
export const MAX_BRIEF_TITLE_CHARS = 500;
export const MAX_BRIEF_BODY_CHARS = 2000;

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

  // A run that already reached a terminal state is finished: re-applying the label must
  // not start a second one. (Aborting or resuming a finished run is meaningless too.)
  for (const terminal of [TRIGGER_LABELS.done, TRIGGER_LABELS.failed]) {
    if (issueLabels.includes(terminal)) {
      return decide(
        "not-a-trigger",
        `the run already reached '${terminal}'; not starting or changing it`,
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
  if (action === "labeled") {
    return decide(
      "trigger",
      `'${clamp(labelName)}' requested dark-factory work on ${clamp(repo)}#${issue}`,
      where,
    );
  }
  if (labelName === questionLabel) {
    return decide(
      "resume",
      `the question label was cleared on ${clamp(repo)}#${issue}; resuming the parked run`,
      where,
    );
  }
  return decide(
    "abort",
    `the trigger label was removed on ${clamp(repo)}#${issue}; aborting the run`,
    where,
  );
}
