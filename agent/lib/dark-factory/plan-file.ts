/**
 * Dark Factory — render an ExecutionPlan as a reviewable markdown plan file (#361, Task 9).
 *
 * The Factory planned in memory only, so a run that failed before its commit left no record of what it
 * intended to do. This renders the plan as a file that can go into the commit, so a failed run still
 * leaves reviewable intent behind.
 *
 * MegaLinter lints changed markdown in the pull request, so the exact output is constrained: every
 * fenced block carries a language (MD040), headings do not repeat (MD024) and do not end in punctuation
 * (MD026). Those are constraints on this renderer, not cosmetic details.
 */

/** A task within the plan's approach. */
export interface PlanTask {
  title: string;
  objective: string;
  files?: string[];
  steps?: string[];
  verification?: string;
}

/**
 * The shape this renderer understands.
 *
 * Deliberately structural and tolerant: `approach` and `tasks` are OPTIONAL. Plans produced today do
 * not carry them, and this renders those without those sections; when the architect starts producing
 * them the sections appear automatically. That keeps this file independent of that schema change rather
 * than making one release depend on another.
 */
export interface PlanFileInput {
  storyId: number;
  title: string;
  summary: string;
  approach?: string;
  tasks?: PlanTask[];
  targetFiles: { path: string; action: string; rationale: string }[];
  acceptanceCriteriaMap?: {
    acId: string;
    description: string;
    testFile: string;
    testCaseName: string;
  }[];
  risks?: string[];
  dependencies?: string[];
}

/** Render a plan as markdown. Not implemented yet (RED stub). */
export function renderPlanFile(
  _plan: PlanFileInput,
  _options: { issueUrl?: string } = {},
): string {
  throw new Error("renderPlanFile is not implemented");
}
