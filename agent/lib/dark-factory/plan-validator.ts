/**
 * Dark Factory — Execution Plan Domain Validator (#179).
 *
 * Pre-flight validation gate that evaluates an ExecutionPlan produced by the
 * Architect Agent before code generation begins. Ensures plans touch appropriate
 * repository domains (e.g. UI/Chat stories modify UI entrypoints) and that every
 * Acceptance Criterion from the User Story is mapped to an automated test case.
 */

import { normalize, isAbsolute } from "node:path";

export interface PlanTargetFile {
  path: string;
  action: "create" | "modify" | "replace";
  rationale: string;
}

export interface AcceptanceCriteriaTestMapping {
  acId: string;
  description: string;
  testFile: string;
  testCaseName: string;
}

/**
 * A task within the plan's approach (#365 Task 8).
 *
 * The canonical definition lives here, with the rest of the plan schema; the plan-file renderer imports
 * it rather than declaring its own, so the two cannot drift apart.
 */
export interface PlanTask {
  title: string;
  objective: string;
  files?: string[];
  steps?: string[];
  verification?: string;
}

export interface ExecutionPlan {
  storyId: number;
  title: string;
  summary: string;
  /**
   * How the change will be made, in prose.
   *
   * Optional on purpose: plans in flight and existing fixtures predate it, and the architect prompt is
   * what asks the model for it. The validator checks its shape when it is present.
   */
  approach?: string;
  /** The work broken into reviewable tasks. Optional for the same reason as `approach`. */
  tasks?: PlanTask[];
  targetFiles: PlanTargetFile[];
  acceptanceCriteriaMap: AcceptanceCriteriaTestMapping[];
  dependencies?: string[];
}

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
}

const UI_SIGNALS = [
  /\bchat ui\b/i,
  /\bweb ui\b/i,
  /\buser navigates\b/i,
  /\bpage loads\b/i,
  /\bbrowser redirects\b/i,
  /\bconsent screen\b/i,
  /\baccess denied (page|screen|message)\b/i,
];

/**
 * Extracts declared AC identifiers (e.g. AC1, AC2, AC-1) or indexed Given/When/Then blocks from story text.
 */
export function extractStoryAcceptanceCriteria(storyText: string): string[] {
  const acIds = new Set<string>();

  // Pattern 1: explicit AC labels like AC1:, AC 1, AC-1
  const explicitMatches = storyText.matchAll(/\b(AC-?\d+)\b/gi);
  for (const match of explicitMatches) {
    acIds.add(match[1].toUpperCase().replace("-", ""));
  }

  // If no explicit AC numbers found, find bullet points starting with 'given'
  if (acIds.size === 0) {
    const lines = storyText.split("\n");
    let count = 1;
    for (const rawLine of lines) {
      const line = rawLine.trim().toLowerCase();
      if (line.startsWith("- given") || line.startsWith("* given")) {
        acIds.add(`AC${count}`);
        count++;
      }
    }
  }

  return Array.from(acIds);
}

/**
 * What a story is scoped to, which decides whether a shell or a shared component is a legitimate target
 * (#381 R2, AC3).
 */
export type StoryScope = "page" | "shell" | "unspecified";

/** Signals that the story names ONE surface. */
const PAGE_SCOPE_SIGNALS: readonly RegExp[] = [
  /\b(?:main|home|landing|index|start|welcome|detail|details|settings|profile|checkout|login|sign[- ]?in|sign[- ]?up|dashboard|category|product|search|results?|error|not[- ]found)\s+page\b/i,
  /\bpage\b/i,
  /\b(?:screen|view|route)\b/i,
  /(?:^|\s)\/(?:[a-z0-9:_-]+)/i,
];

/**
 * Signals that the story is about something on EVERY route, in which case the shell is the correct target.
 *
 * `shell`, `wrapper` and `layout` belong here even when a story uses them loosely ("run the shell script"):
 * the shell reading only ever ALLOWS a target, so a false positive here cannot block a change.
 */
const SHELL_SCOPE_SIGNALS: readonly RegExp[] = [
  /\bevery\s+(?:page|route|screen|view)\b/i,
  /\ball\s+(?:pages|routes|screens|views)\b/i,
  /\b(?:nav|navbar|navigation|header|footer|sidebar|layout|shell|wrapper)\b/i,
  /\bglobal(?:ly)?\b/i,
];

/** The word "page" in a non-UI context: paging, page size, page count. */
const PAGE_NON_UI = /\bpage\s+(?:size|count|limit|fault)\b|\bpaginat\w*\b|\boffset\b/gi;

function isUsableText(storyText: string): boolean {
  return typeof storyText === "string" && storyText.trim() !== "";
}

/**
 * True when the story is about something rendered on EVERY route, so the application shell is the correct
 * target rather than a mistake. This takes precedence over the page signals: "the heading on every page" is
 * shell work, and a rule that refused it would block legitimate changes.
 */
export function isShellScopedStory(storyText: string): boolean {
  if (!isUsableText(storyText)) return false;
  return SHELL_SCOPE_SIGNALS.some((pattern) => pattern.test(storyText));
}

/**
 * True when the story names ONE surface, so a shell or a shared component is the wrong target for it.
 * False when the story is shell-scoped, because the shell-scoped reading wins.
 */
export function isPageScopedStory(storyText: string): boolean {
  if (!isUsableText(storyText)) return false;
  // The shell reading wins. A story about every route is shell work whatever else it mentions, and getting
  // this precedence wrong is how the rule would block a legitimate change instead of a mistaken one.
  if (isShellScopedStory(storyText)) return false;
  // "page" outside a UI context is not a surface: page size, page count, pagination. Strip those phrases
  // first, so a database story is not read as being about a screen.
  const withoutNonUi = storyText.replace(PAGE_NON_UI, " ");
  return PAGE_SCOPE_SIGNALS.some((pattern) => pattern.test(withoutNonUi));
}

/**
 * Validates an ExecutionPlan against the user story text and domain invariants.
 */
export function validateExecutionPlan(
  plan: ExecutionPlan,
  storyText: string,
): PlanValidationResult {
  const errors: string[] = [];

  // 0. Runtime schema integrity checks
  if (!plan || typeof plan !== "object") {
    return { valid: false, errors: ["Plan must be a valid non-null object."] };
  }
  if (typeof plan.storyId !== "number" || isNaN(plan.storyId)) {
    errors.push("Plan storyId must be a valid number.");
  }
  if (!plan.title || typeof plan.title !== "string") {
    errors.push("Plan title must be a non-empty string.");
  }

  // 1. Target files presence check
  if (!Array.isArray(plan.targetFiles) || plan.targetFiles.length === 0) {
    errors.push("Plan must specify at least one target file.");
    return { valid: false, errors };
  }

  // 2. Path safety check (no path traversal, relative paths only)
  for (const file of plan.targetFiles) {
    if (!file || typeof file !== "object") {
      errors.push("Target file entries must be objects.");
      continue;
    }
    const p = (file.path ?? "").trim();
    if (!p) {
      errors.push("Target file path cannot be empty.");
      continue;
    }
    if (file.action !== "create" && file.action !== "modify" && file.action !== "replace") {
      errors.push(
        `Target file '${p}' action must be 'create', 'modify', or 'replace' (received '${file.action}').`,
      );
    }
    if (p.includes("\0")) {
      errors.push(`Target file '${p}' contains a null byte.`);
      continue;
    }
    if (isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith("\\\\") || p.startsWith("//")) {
      errors.push(`Target file '${p}' must be relative to repository root.`);
      continue;
    }
    const norm = normalize(p).replace(/\\/g, "/");
    if (norm === ".." || norm.startsWith("../") || norm.includes("/../")) {
      errors.push(`Target file '${p}' contains illegal path traversal ('..').`);
    }
  }

  // 2b. Plan structure (#365 Task 8): the shape of the approach and the tasks is checked when provided.
  // Both fields are OPTIONAL, so plans that predate them keep validating; the architect PROMPT is what
  // asks the model for them, and a malformed value is still refused.
  if (plan.approach !== undefined && String(plan.approach).trim() === "") {
    errors.push("Plan 'approach' must be a non-empty string when provided.");
  }
  if (plan.tasks !== undefined) {
    if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
      errors.push("Plan 'tasks' must contain at least one task when provided.");
    } else {
      plan.tasks.forEach((task, index) => {
        const position = index + 1;
        if (!task || typeof task !== "object") {
          errors.push(`Plan task ${position} must be an object.`);
          return;
        }
        if (!task.title || String(task.title).trim() === "") {
          errors.push(`Plan task ${position} must have a non-empty 'title'.`);
        }
        if (!task.objective || String(task.objective).trim() === "") {
          errors.push(`Plan task ${position} must have a non-empty 'objective'.`);
        }
      });
    }
  }

  // 3. Domain relevance check: UI/Chat stories must touch app/ or components/
  const isUiStory = UI_SIGNALS.some((pattern) => pattern.test(storyText));
  if (isUiStory) {
    const hasUiTarget = plan.targetFiles.some(
      (f) =>
        f.path.startsWith("app/") ||
        f.path.startsWith("components/") ||
        f.path.startsWith("src/app/") ||
        f.path.startsWith("src/components/"),
    );
    if (!hasUiTarget) {
      errors.push(
        "UI/Chat story must modify or create files under app/ or components/ (e.g. app/page.tsx or app/chat.tsx).",
      );
    }
  }

  // 4. Acceptance Criteria mapping check
  const requiredAcs = extractStoryAcceptanceCriteria(storyText);
  const mappedAcIds = new Set(
    (plan.acceptanceCriteriaMap || []).map((m) =>
      m.acId.toUpperCase().replace("-", ""),
    ),
  );

  for (const acId of requiredAcs) {
    if (!mappedAcIds.has(acId)) {
      errors.push(`Missing test mapping for AC: ${acId}.`);
    }
  }

  // 5. Test mapping completeness check
  if (plan.acceptanceCriteriaMap) {
    for (const mapping of plan.acceptanceCriteriaMap) {
      if (!mapping.testFile?.trim() || !mapping.testCaseName?.trim()) {
        errors.push(
          `AC mapping '${mapping.acId || "unknown"}' is incomplete: missing testFile or testCaseName.`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Safely parses JSON while stripping prototype pollution vectors (__proto__, constructor, prototype).
 */
export function safeJsonParse<T = unknown>(jsonString: string): T {
  return JSON.parse(jsonString, (key, value) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return undefined;
    }
    return value;
  });
}

/**
 * Adapter interface for parsing ExecutionPlans from raw LLM output.
 */
export interface PlanParser {
  parse(rawText: string): { plan: ExecutionPlan | null; error?: string };
}

/**
 * Default adapter implementation for parsing ExecutionPlan JSON from LLM text.
 * Strips markdown fences, extracts JSON object, and guards against prototype pollution.
 */
export class DefaultPlanParser implements PlanParser {
  parse(text: string): { plan: ExecutionPlan | null; error?: string } {
    try {
      let raw = (text ?? "").trim();
      if (raw.startsWith("```")) {
        raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      }
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        raw = jsonMatch[0];
      }
      const plan = safeJsonParse<ExecutionPlan>(raw);
      return { plan };
    } catch (err: any) {
      return {
        plan: null,
        error: `JSON parse failed: ${err.message}`,
      };
    }
  }
}
