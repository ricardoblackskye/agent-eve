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

export function assessPreservation(_input: PreservationInput): PreservationVerdict {
  throw new Error("assessPreservation is not implemented");
}
