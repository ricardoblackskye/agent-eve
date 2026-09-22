/**
 * Dark Factory — Execution Plan Domain Validator (#179).
 *
 * Pre-flight validation gate that evaluates an ExecutionPlan produced by the
 * Architect Agent before code generation begins. Ensures plans touch appropriate
 * repository domains (e.g. UI/Chat stories modify UI entrypoints) and that every
 * Acceptance Criterion from the User Story is mapped to an automated test case.
 */

export interface PlanTargetFile {
  path: string;
  action: "create" | "modify";
  rationale: string;
}

export interface AcceptanceCriteriaTestMapping {
  acId: string;
  description: string;
  testFile: string;
  testCaseName: string;
}

export interface ExecutionPlan {
  storyId: number;
  title: string;
  summary: string;
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
 * Validates an ExecutionPlan against the user story text and domain invariants.
 */
export function validateExecutionPlan(
  plan: ExecutionPlan,
  storyText: string,
): PlanValidationResult {
  const errors: string[] = [];

  // 1. Target files presence check
  if (!plan.targetFiles || plan.targetFiles.length === 0) {
    errors.push("Plan must specify at least one target file.");
    return { valid: false, errors };
  }

  // 2. Path safety check (no path traversal, relative paths only)
  for (const file of plan.targetFiles) {
    const p = file.path.trim();
    if (!p) {
      errors.push("Target file path cannot be empty.");
      continue;
    }
    if (p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) {
      errors.push(`Target file '${p}' must be relative to repository root.`);
    }
    if (p.includes("..")) {
      errors.push(`Target file '${p}' contains illegal path traversal ('..').`);
    }
  }

  // 3. Domain relevance check: UI/Chat stories must touch app/ or components/
  const isUiStory = UI_SIGNALS.some((pattern) => pattern.test(storyText));
  if (isUiStory) {
    const hasUiTouchpoint = plan.targetFiles.some(
      (f) =>
        f.path.startsWith("app/") ||
        f.path.startsWith("components/") ||
        f.path.startsWith("src/app/") ||
        f.path.startsWith("src/components/"),
    );
    if (!hasUiTouchpoint) {
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
