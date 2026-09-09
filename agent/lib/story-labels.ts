export const TRIGGER_LABEL = "needs-story";
export const DONE_LABEL = "user-story-added";

/**
 * Compute the label choreography for finalising a user-story pipeline run.
 *
 * On a successful publish we remove the trigger label (`needs-story`) and add
 * the completion label (`user-story-added`). On a non-success state (e.g. the
 * story still needs clarification) we do nothing, so a re-apply of the trigger
 * label is not silently masked and the issue stays open for questions.
 */
export function finalizeLabels(
  current: string[],
  opts: { success: boolean },
): { add: string[]; remove: string[] } {
  if (!opts.success) return { add: [], remove: [] };
  const remove = current.filter((l) => l.toLowerCase() === TRIGGER_LABEL);
  return { add: [DONE_LABEL], remove };
}