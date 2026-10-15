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

/** Heading text must not end in punctuation (MD026), and must be a single line. */
function headingText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/, "")
    .trim();
}

/** A table cell cannot hold a raw pipe (it would end the cell) or a newline (it would end the row). */
function cell(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Give every fenced block an info string, so markdownlint MD040 (fenced-code-language) passes.
 *
 * A model-authored approach or summary can carry a fence with no info string, and a generated file
 * containing one fails MD040 in the pull request's MegaLinter run. Stateful on purpose: inside a fence a
 * bare ``` is the CLOSER, so tracking whether we are inside one is the only way to tell the two apart.
 */
function withFenceLanguages(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("```")) return line;
      if (inFence) {
        inFence = false;
        return line;
      }
      inFence = true;
      // An opener that already carries an info string is left exactly as it was.
      return trimmed === "```" ? "```text" : line;
    })
    .join("\n");
}

/** Render a plan as a reviewable markdown file. */
export function renderPlanFile(
  plan: PlanFileInput,
  options: { issueUrl?: string } = {},
): string {
  const lines: string[] = [];

  lines.push(`# Plan: ${headingText(plan.title)}`, "");
  lines.push(`Story: #${plan.storyId}`);
  if (options.issueUrl) {
    lines.push(`Issue: ${options.issueUrl}`);
  }
  lines.push("");

  lines.push("## Goal", "", plan.summary.trim(), "");

  if (plan.approach && plan.approach.trim() !== "") {
    lines.push("## Approach", "", plan.approach.trim(), "");
  }

  const tasks = plan.tasks ?? [];
  if (tasks.length > 0) {
    lines.push("## Tasks", "");
    tasks.forEach((task, index) => {
      // The number keeps each heading unique even when two tasks share a title (MD024).
      lines.push(`### ${index + 1}. ${headingText(task.title)}`, "");
      lines.push(`**Objective:** ${task.objective.trim()}`, "");
      if (task.files && task.files.length > 0) {
        lines.push(`**Files:** ${task.files.map((f) => `\`${f}\``).join(", ")}`, "");
      }
      if (task.steps && task.steps.length > 0) {
        lines.push("**Steps:**", "");
        task.steps.forEach((step, i) => lines.push(`${i + 1}. ${step.trim()}`));
        lines.push("");
      }
      if (task.verification) {
        lines.push(`**Verification:** ${task.verification.trim()}`, "");
      }
    });
  }

  lines.push("## Files to change", "");
  lines.push("| File | Action | Rationale |", "| --- | --- | --- |");
  for (const file of plan.targetFiles) {
    lines.push(
      `| \`${cell(file.path)}\` | ${cell(file.action)} | ${cell(file.rationale)} |`,
    );
  }
  lines.push("");

  const acceptanceCriteria = plan.acceptanceCriteriaMap ?? [];
  if (acceptanceCriteria.length > 0) {
    lines.push("## Acceptance criteria", "");
    lines.push("| AC | Test | Case |", "| --- | --- | --- |");
    for (const ac of acceptanceCriteria) {
      lines.push(
        `| ${cell(ac.acId)} | \`${cell(ac.testFile)}\` | ${cell(ac.testCaseName)} |`,
      );
    }
    lines.push("");
  }

  const risks = plan.risks ?? [];
  if (risks.length > 0) {
    lines.push("## Risks", "");
    for (const risk of risks) {
      lines.push(`- ${risk.trim()}`);
    }
    lines.push("");
  }

  const dependencies = plan.dependencies ?? [];
  if (dependencies.length > 0) {
    lines.push("## Dependencies", "");
    for (const dependency of dependencies) {
      lines.push(`- ${dependency.trim()}`);
    }
    lines.push("");
  }

  const body = withFenceLanguages(lines.join("\n")).replace(/\n+$/, "");
  return `${body}\n`;
}
