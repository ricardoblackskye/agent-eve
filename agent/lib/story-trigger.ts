import { DONE_LABEL } from "./story-labels";

export interface TriggerPayload {
  action: string;
  issue?: {
    number?: number;
    title?: string;
    body?: string;
    labels?: Array<{ name: string }>;
  };
  label?: { name: string };
  pull_request?: unknown;
}

export interface TriggerDefaults {
  mention: string;
  label: string;
}

export const TRIGGER_DEFAULTS: TriggerDefaults = {
  mention: "@eve-agent",
  label: "needs-story",
};

function getEnvMention(): string {
  return process.env.EVE_STORY_MENTION?.trim() || TRIGGER_DEFAULTS.mention;
}

function getEnvLabel(): string {
  return process.env.EVE_STORY_LABEL?.trim() || TRIGGER_DEFAULTS.label;
}

/**
 * Decide whether a GitHub issue event should kick off user-story generation.
 *
 * Fires when EITHER:
 *   - the issue was opened/labeled/closed AND its body (or a label) mentions
 *     the configured agent handle (default `@eve-agent`), OR
 *   - the issue was labeled with the configured trigger label (default
 *     `needs-story`), case-insensitive.
 *
 * Does NOT fire for pull_request events, or for `closed`/`deleted` actions
 * unless they also carry the trigger mention/label.
 */
export function isStoryTrigger(payload: TriggerPayload): boolean {
  if (payload.pull_request) return false;

  const action = payload.action;
  // Closing/deleting an issue never (re)generates a story, regardless of any
  // earlier mention or label — those are terminal events for the source issue.
  if (action === "closed" || action === "deleted") {
    return false;
  }

  // A story has already been generated for this issue (finalization applied the
  // completion label) — never re-trigger, even if the trigger label is
  // (re-)applied or a mention still matches. This is the dedup guard that
  // prevents duplicate [Story] issues.
  if (hasDoneLabel(payload)) return false;

  if (action === "labeled") {
    const label = (payload.label?.name || "").toLowerCase();
    if (label && label === getEnvLabel().toLowerCase()) return true;
    return hasMention(payload);
  }

  // opened / edited / reopened / etc.
  return hasMention(payload);
}

function hasMention(payload: TriggerPayload): boolean {
  const mention = getEnvMention().toLowerCase().replace(/^@/, "");
  const body = (payload.issue?.body || "").toLowerCase();
  const labels = (payload.issue?.labels || []).map((l) =>
    (l.name || "").toLowerCase(),
  );
  return body.includes(`@${mention}`) || labels.includes(mention);
}

function hasDoneLabel(payload: TriggerPayload): boolean {
  const done = DONE_LABEL.toLowerCase();
  return (payload.issue?.labels || []).some(
    (l) => (l.name || "").toLowerCase() === done,
  );
}
