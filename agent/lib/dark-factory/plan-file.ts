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

// Imported for local use AND re-exported: a bare `export type { X } from "..."` re-exports without
// bringing the name into scope, which silently turned this module's task typing into `any`.
import type { PlanTask } from "./plan-validator";

export type { PlanTask };

/**
 * The shape this renderer understands.
 *
 * Deliberately structural and tolerant: `approach` and `tasks` are OPTIONAL. Plans produced today do
 * not carry them, and this renders those without those sections; when the architect starts producing
 * them the sections appear automatically. That keeps this file independent of that schema change rather
 * than making one release depend on another.
 */
export interface PlanFileInput {
  /**
   * #780 (R3): the substitution this plan declares, when it writes something other than the surface its story names.
   *
   * Typed structurally rather than imported, matching how renderSubstitutionLine is typed: a type-only import across
   * these modules buys nothing here and risks a cycle for no benefit.
   */
  substitution?: { chosen: string; named: string; reason: string };
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

/**
 * A field the renderer was not given renders as a visible marker, never as a thrown TypeError.
 *
 * #503: the architect's returned plan used a different vocabulary for `targetFiles` (`changeType`/
 * `reason`) than the renderer reads (`action`/`rationale`), so the missing fields were `undefined` and
 * the original `text.replace(...)` threw "Cannot read properties of undefined (reading 'replace')" at
 * STEP 5 — before the plan comment or the park. The plan validator is allowed to accept these shapes, so
 * the display layer must tolerate them rather than aborting the run.
 */
const MISSING_VALUE = "—";

function toText(value: unknown): string {
  return typeof value === "string" ? value : MISSING_VALUE;
}

/** Heading text must not end in punctuation (MD026), and must be a single line. */
function headingText(text: unknown): string {
  return neutralizeBareUrls(toText(text))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?]+$/, "")
    .trim();
}

/**
 * A table cell cannot hold a raw pipe (it would end the cell) or a newline (it would end the row).
 *
 * Backslashes are escaped BEFORE pipes, and the order matters: escaping only the pipe leaves a
 * backslash able to escape the next character, so a value ending in one swallows the cell separator and
 * the row stops being the table it claims to be. CodeQL flags the reverse order as
 * js/incomplete-sanitization, and it is right to.
 *
 * #679 - the inline-HTML pass runs HERE, on the cell text, rather than being left to the body pass that
 * runs after the whole file is assembled. That pass code-spans a markup run, which ADDS TWO CHARACTERS,
 * so a cell containing markup grew AFTER `renderTable` had already padded the column to the width it
 * measured - and the row's trailing pipe landed two columns right of the header's. That is exactly what
 * the target's linter reported on WebFeedPOC#231 (MD060, "Table pipe does not align with header"), on a
 * table the factory had written itself. Applying it here means the width is measured on the text that
 * is rendered, which is what this module already claims to do. The body pass still runs, and is a no-op
 * for cells because a tag inside a code span is deliberately not wrapped twice.
 */
function cell(text: unknown): string {
  return neutralizeInlineHtml(neutralizeBareUrls(toText(text)))
    .replace(/\s+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();
}

/**
 * Coerce a prose field to trimmed text, or "" when it is not a string.
 *
 * #503 Task 4 — the third instance of the same class as the STEP 5 crash. Making `cell`/`headingText`
 * total fixed only the first throw; the very next real run died at `risk.trim is not a function`,
 * because the architect's RETURNED plan does not match the declared types: `risks` arrives as
 * `{risk, mitigation}` pairs while `PlanFileInput` says `string[]`. Every other emitted field
 * (`summary`, `approach`, `objective`, `steps`, `verification`, `dependencies`) is the same latent
 * crash one line later. Rendering a missing field as "" omits its section instead of aborting the run
 * before the plan comment and the park.
 */
function text(value: unknown): string {
  return typeof value === "string" ? neutralizeBareUrls(value.trim()) : "";
}

/**
 * A risk may arrive as a string or as a `{risk, mitigation}` pair.
 *
 * The mitigation is rendered WITH the risk rather than dropped: a reviewer needs both halves to judge
 * whether the risk is acceptable. An unrecognised shape renders as "" and is skipped.
 */
function riskText(value: unknown): string {
  if (typeof value === "string") return neutralizeBareUrls(value.trim());
  if (typeof value === "object" && value !== null) {
    const { risk, mitigation } = value as { risk?: unknown; mitigation?: unknown };
    const head = typeof risk === "string" ? neutralizeBareUrls(risk.trim()) : "";
    const tail = typeof mitigation === "string" ? neutralizeBareUrls(mitigation.trim()) : "";
    if (head && tail) return `${head} (Mitigation: ${tail})`;
    return head || tail;
  }
  return "";
}

/**
 * Give every fenced block an info string, so markdownlint MD040 (fenced-code-language) passes.
 *
 * A model-authored approach or summary can carry a fence with no info string, and a generated file
 * containing one fails MD040 in the pull request's MegaLinter run. Stateful on purpose: inside a fence a
 * bare ``` is the CLOSER, so tracking whether we are inside one is the only way to tell the two apart.
 */
/**
 * Raw inline HTML in prose becomes an inline code span.
 *
 * #666: the architect describes a UI change by quoting the element - "the block gains
 * `<p><em>Built by ...</em></p>`" - and MegaLinter lints the generated plan, where raw inline HTML in
 * prose fails MD033 (no-inline-html). Measured on WebFeedPOC#226: twelve findings against a plan whose
 * product change was correct, and the run's own gate could not see them, because the target declares
 * lint and typecheck while markdownlint runs only in CI. A code span is what MD033 ignores and it keeps
 * the tag readable - the same reasoning as the bare-URL rule below, and the same rule about fences.
 */
/**
 * A run of markup: a tag, then any number of (text, tag) pairs.
 *
 * Wrapping tags INDIVIDUALLY is wrong, and the probe that proved it rendered as
 * "`<p>``<em>`Built by ...`</em>``</p>`" - adjacent backtick runs, which CommonMark then matches as
 * different delimiters and displays wrongly. Matching the whole run instead yields one span around
 * "`<p><em>Built by ...</em></p>`", which is what a reader expects and what the plan describes.
 *
 * The trailing group requires ANOTHER tag to continue, so the run stops at the last tag and cannot
 * swallow the prose that follows it. Text BETWEEN tags is included, which is deliberate: an element's
 * content belongs to its code span.
 */
const MARKUP_RUN =
  /(?:<\/?[A-Za-z][^<>]*>)(?:[^<>]*<\/?[A-Za-z][^<>]*>)*/g;

function neutralizeInlineHtml(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trim().startsWith("```")) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      // Code spans are protected: a tag already inside one must not be wrapped a second time, so the
      // odd indices of this split - the spans themselves - are returned untouched. Splitting with a
      // capture group keeps the separators, which is what makes that indexing work.
      //
      // Comments are deliberately NOT filtered here. An earlier version stripped them, and CodeQL
      // flagged it as js/bad-tag-filter: a single-line pattern cannot match a comment spanning lines.
      // The honest resolution is that the filter was never needed - the plan's own directives carry no
      // tags to wrap, so nothing inside a comment ever required shielding.
      return line
        .split(/(`[^`]*`)/)
        .map((part, index) =>
          index % 2 === 1
            ? part
            : part.replace(MARKUP_RUN, (run) => `\`${run}\``),
        )
        .join("");
    })
    .join("\n");
}

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

/**
 * A bare URL becomes an inline code span.
 *
 * MegaLinter lints the generated plan, and a URL the MODEL wrote in prose used to be emitted verbatim:
 * that fails MD034 (no-bare-urls). Wrapping it in an autolink instead would only move the problem, because
 * a link checker then FOLLOWS it and reports the unreachable ones - a dev-server URL such as
 * `http://localhost:5173/` is guaranteed to fail. A code span is the one form that is neither a bare URL
 * nor a link, and it keeps the URL readable.
 *
 * Left alone: a URL inside a fenced block or an inline code span (neither is bare, and both are ignored by
 * the linters), and a URL in a markdown link's target - that is the model's own legitimate link, and
 * rewriting it would break the link's syntax.
 */
const BARE_URL = /(^|[^`<(])(https?:\/\/[^\s`<>]+)/g;

function codeSpanUrls(segment: string): string {
  return segment.replace(BARE_URL, (_match, lead: string, url: string) => {
    const trailing = url.match(/[.,;:]+$/)?.[0] ?? "";
    const bare = trailing === "" ? url : url.slice(0, -trailing.length);
    return `${lead}\`${bare}\`${trailing}`;
  });
}

function neutralizeBareUrls(value: string): string {
  let inFence = false;
  return value
    .split("\n")
    .map((line) => {
      if (line.trim().startsWith("```")) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((segment) => (segment.startsWith("`") ? segment : codeSpanUrls(segment)))
        .join("");
    })
    .join("\n");
}

/**
 * Render a table in the pinned markdown-table-formatter shape.
 *
 * MegaLinter runs markdown-table-formatter over changed markdown, and it rewrites a `| --- |` separator
 * into dashes padded to each column's width. A renderer that emits the form that is not padded is therefore flagged
 * on EVERY run - which is exactly what happened to a real plan artifact. Widths are measured on the
 * ESCAPED, NEUTRALIZED cell text, because that is what ends up in the line.
 */
function renderTable(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const render = (cells: string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ")} |`;
  const separator = `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`;
  return [render(header), separator, ...rows.map(render)];
}

/** Render a plan as a reviewable markdown file. */
export function renderPlanFile(
  plan: PlanFileInput,
  options: { issueUrl?: string; scope?: { shellScoped: boolean; pageScoped: boolean } } = {},
): string {
  const lines: string[] = [];

  // MD013 (line-length, 80 columns) cannot be satisfied for model-authored prose or for table cells,
  // which must not be wrapped without corrupting them. This repository silences that one rule in its own
  // generated catalogue (docs/pages/dark-factory-modules.md), so the generated plan follows the same
  // precedent. The rules this renderer CAN satisfy - MD040, MD024, MD026 - are deliberately left on.
  lines.push("<!-- markdownlint-disable MD013 -->", "");

  // #659: exempt the GENERATED file from the target's spell-checker. cspell reads that repository's
  // dictionary, which knows general English rather than the model's domain vocabulary - measured on
  // WebFeedPOC, whose own `build:prerender` script's word `prerendered` it rejected. The artifact is
  // rendered after the coding loop and the Definition of Done cannot fix it, so a spell failure here
  // meant no run could ever complete. This applies to this file only; human-authored files stay checked.
  lines.push("<!-- cspell:disable -->", "");

  lines.push(`# Plan: ${headingText(plan.title)}`, "");
  lines.push(`Story: #${plan.storyId}`);
  if (options.issueUrl) {
    // A markdown link, never a bare URL: MD034 flags bare URLs, and the factory's own PR is linted.
    lines.push(`Issue: [#${plan.storyId}](${options.issueUrl})`);
  }
  lines.push("");

  // #780 (R3): the substitution DECLARATION, and it comes BEFORE the technical detail. The requirement says the plan
  // must state which target won and why "at the top of the plan as one line", so this is not a nicety of layout: a
  // declaration buried in the approach prose is the thing it was meant to fix, and an approver left to infer the
  // choice is the defect this release exists to remove.
  if (plan.substitution) {
    lines.push(renderSubstitutionLine(plan.substitution), "");
  }

  // #784: the READING the target choice rests on, beside the declaration and for the same reason. The declaration
  // says what was chosen; the reading says what it was chosen against. Together they let an approver tell a
  // deliberate reading from an accident, which is the whole point - R4's runs targeted the shell for a story that
  // says "home page" and were CORRECT, but the plan never said why.
  if (options.scope) {
    lines.push(renderScopeReading(options.scope), "");
  }

  lines.push("## Goal", "", text(plan.summary), "");

  const approach = text(plan.approach);
  if (approach !== "") {
    lines.push("## Approach", "", approach, "");
  }

  const tasks = plan.tasks ?? [];
  if (tasks.length > 0) {
    lines.push("## Tasks", "");
    tasks.forEach((task, index) => {
      // The number keeps each heading unique even when two tasks share a title (MD024).
      lines.push(`### ${index + 1}. ${headingText(task.title)}`, "");
      const objective = text(task.objective);
      if (objective !== "") {
        lines.push(`**Objective:** ${objective}`, "");
      }
      if (task.files && task.files.length > 0) {
        lines.push(`**Files:** ${task.files.map((f) => `\`${f}\``).join(", ")}`, "");
      }
      if (task.steps && task.steps.length > 0) {
        lines.push("**Steps:**", "");
        // Coerce before numbering so a non-string step cannot crash the renderer (#503 Task 4).
        const steps = task.steps.map(text).filter((step) => step !== "");
        steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
        lines.push("");
      }
      const verification = text(task.verification);
      if (verification !== "") {
        lines.push(`**Verification:** ${verification}`, "");
      }
    });
  }

  lines.push("## Files to change", "");
  lines.push(
    ...renderTable(
      ["File", "Action", "Rationale"],
      plan.targetFiles.map((file) => [
        `\`${cell(file.path)}\``,
        cell(file.action),
        cell(file.rationale),
      ]),
    ),
  );
  lines.push("");

  const acceptanceCriteria = plan.acceptanceCriteriaMap ?? [];
  if (acceptanceCriteria.length > 0) {
    lines.push("## Acceptance criteria", "");
    lines.push(
      ...renderTable(
        ["AC", "Test", "Case"],
        acceptanceCriteria.map((ac) => [
          cell(ac.acId),
          `\`${cell(ac.testFile)}\``,
          cell(ac.testCaseName),
        ]),
      ),
    );
    lines.push("");
  }

  // Coerce first: `risks` arrives as {risk, mitigation} pairs from the model while the type says
  // string[], and the raw `risk.trim()` here is what killed the real run (#503 Task 4).
  const risks = (plan.risks ?? []).map(riskText).filter((risk) => risk !== "");
  if (risks.length > 0) {
    lines.push("## Risks", "");
    for (const risk of risks) {
      lines.push(`- ${risk}`);
    }
    lines.push("");
  }

  const dependencies = (plan.dependencies ?? []).map(text).filter((dependency) => dependency !== "");
  if (dependencies.length > 0) {
    lines.push("## Dependencies", "");
    for (const dependency of dependencies) {
      lines.push(`- ${dependency}`);
    }
    lines.push("");
  }

  // Both passes are fence-aware and independent, so their order does not matter; the inline-HTML
  // pass runs first so the fence pass sees exactly the text the renderer produced.
  const body = withFenceLanguages(neutralizeInlineHtml(lines.join("\n"))).replace(/\n+$/, "");
  return `${body}\n`;
}

/**
 * #780 (R3): the substitution declaration, as ONE line at the top of the plan.
 *
 * The requirement says "as one line", so this returns one line and the caller must not wrap it into prose: a
 * declaration that becomes a paragraph is the thing it was meant to fix.
 */
export function renderSubstitutionLine(declaration: {
  chosen: string;
  named: string;
  reason: string;
}): string {
  let clean = declaration.reason.trim();
  while (clean.endsWith(".")) clean = clean.slice(0, -1);
  return `Substituted: ${declaration.chosen} for ${declaration.named}, because ${clean}.`;
}

/**
 * #784: the scope reading, as one line at the top of the plan.
 *
 * Rendered from the same two classifiers the validator acts on (isShellScopedStory / isPageScopedStory), so the plan
 * cannot state a reading the rules disagreed with.
 *
 * The third case is deliberate: a story matching NO scope signal is real, and saying so is better than implying a
 * reading was made when none was. Without it, an absent line would be ambiguous between not rendered, not computed,
 * and no reading at all.
 */
export function renderScopeReading(scope: { shellScoped: boolean; pageScoped: boolean }): string {
  if (scope.shellScoped) {
    return "Scope: this story reads as shell-scoped work, so a target in the application shell is intended rather than accidental.";
  }
  if (scope.pageScoped) {
    return "Scope: this story reads as page-scoped work, so it is a change to one surface rather than to the application shell.";
  }
  return "Scope: this story matches no scope signal, so the target choice rests on the plan's reading of the repository rather than on a scope rule.";
}
