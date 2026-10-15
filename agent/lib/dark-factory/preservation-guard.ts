/**
 * #361 — the preservation guard.
 *
 * The first full end-to-end run replaced a 75-line component with a 15-line stub and still reported
 * `DoD Status: done`, because nothing compared what the loop authored against what was already there.
 * This module makes that comparison explicit and testable.
 *
 * It is a PURE function over two strings: no filesystem, no clock, no environment. That keeps the rule
 * unit-testable at its exact boundary, and keeps the I/O and the decision in separate places.
 */

/** A target file's declared intent. `replace` is the only action that sanctions losing the old content. */
export type PlanFileAction = "create" | "modify" | "replace";

export interface PreservationInput {
  /** Relative path, used only to make the reason readable. */
  path: string;
  action: PlanFileAction;
  /** The file's content before the loop touched it; empty when the file did not exist. */
  before: string;
  /** The content the author produced. */
  after: string;
}

export interface PreservationVerdict {
  ok: boolean;
  /** Non-blank lines in `before`. */
  beforeLines: number;
  /** Non-blank lines in `after`. */
  afterLines: number;
  /**
   * Non-blank `before` lines that no longer appear in `after`, compared trimmed and with duplicates
   * counted, so re-indenting a file is not mistaken for deleting it.
   */
  removedLines: number;
  /** `removedLines / beforeLines`; 0 when there was nothing to preserve. */
  removedRatio: number;
  /** Always explains the outcome; safe to show in a failure message. */
  reason: string;
}

/** More than half of the original lines gone is a rewrite, not an edit. */
export const MAX_REMOVED_RATIO = 0.5;

/** Non-blank, trimmed lines: indentation and trailing blanks are not content. */
function contentLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * How many of `before`'s lines are absent from `after`, honouring duplicates: if `before` has a line
 * twice and `after` once, exactly one was removed.
 */
function countMissingLines(before: string[], after: string[]): number {
  const available = new Map<string, number>();
  for (const line of after) {
    available.set(line, (available.get(line) ?? 0) + 1);
  }
  let missing = 0;
  for (const line of before) {
    const remaining = available.get(line) ?? 0;
    if (remaining > 0) available.set(line, remaining - 1);
    else missing += 1;
  }
  return missing;
}

export function assessPreservation(
  input: PreservationInput,
): PreservationVerdict {
  const before = contentLines(input.before);
  const after = contentLines(input.after);
  const beforeLines = before.length;
  const afterLines = after.length;

  // Nothing to preserve: a genuinely new file.
  if (beforeLines === 0) {
    return {
      ok: true,
      beforeLines,
      afterLines,
      removedLines: 0,
      removedRatio: 0,
      reason: `'${input.path}' has no existing content to preserve.`,
    };
  }

  const removedLines = countMissingLines(before, after);
  const removedRatio = removedLines / beforeLines;
  const kept = beforeLines - removedLines;

  // An explicit plan declaration is the ONLY sanction for losing the old content.
  if (input.action === "replace") {
    return {
      ok: true,
      beforeLines,
      afterLines,
      removedLines,
      removedRatio,
      reason:
        `'${input.path}' is declared a replacement in the plan, so losing ` +
        `${removedLines} of ${beforeLines} existing lines is sanctioned.`,
    };
  }

  if (removedRatio > MAX_REMOVED_RATIO) {
    const percent = Math.round(removedRatio * 100);
    const limit = Math.round(MAX_REMOVED_RATIO * 100);
    return {
      ok: false,
      beforeLines,
      afterLines,
      removedLines,
      removedRatio,
      reason:
        `'${input.path}' would lose ${removedLines} of ${beforeLines} existing lines ` +
        `(${percent}%), which is more than the ${limit}% a 'modify' may remove. ` +
        `Preserve the existing code, or declare action "replace" in the plan if a ` +
        `whole-file replacement really is the task.`,
    };
  }

  return {
    ok: true,
    beforeLines,
    afterLines,
    removedLines,
    removedRatio,
    reason: `'${input.path}' keeps ${kept} of ${beforeLines} existing lines.`,
  };
}
