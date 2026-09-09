export const TRIGGER_LABEL = "needs-story";
export const DONE_LABEL = "user-story-added";

/**
 * Describe the intended label transition for finalizing a story pipeline run.
 *
 * These are *target-state* operations: on success the source issue should no
 * longer carry the trigger label and should carry the completion label. They
 * are applied idempotently by the provider (each add/remove is skipped when the
 * issue is already in the desired state) rather than derived from a
 * caller-supplied snapshot of the issue's current labels — a caller that fakes
 * that snapshot silently produces a spurious remove. On a non-success state
 * (e.g. the story still needs clarification) there is nothing to change.
 */
export function finalizeLabels(opts: { success: boolean }): {
  add: string[];
  remove: string[];
} {
  if (!opts.success) return { add: [], remove: [] };
  return { add: [DONE_LABEL], remove: [TRIGGER_LABEL] };
}