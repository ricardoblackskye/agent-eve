/**
 * Dark Factory — Definition of Done Markdown Presentation Layer (#179).
 *
 * Formats AC traceability matrices and accepted review finding comments
 * for GitHub PR discussions. Keeps domain verification decoupled from markdown rendering.
 */

import type { AcceptanceCriteriaTestMapping } from "./plan-validator";
import type { ReviewFinding } from "./definition-of-done";

export interface AcTraceabilityItem extends AcceptanceCriteriaTestMapping {
  passed: boolean;
}

/**
 * Render a markdown table detailing Acceptance Criteria traceability to test cases.
 */
export function renderAcTraceabilityTable(matrix: AcTraceabilityItem[]): string {
  const header = [
    "### Acceptance Criteria Traceability Matrix",
    "",
    "| AC ID | Description | Test File | Test Case | Status |",
    "|:---|:---|:---|:---|:---|",
  ];
  const rows = matrix.map(
    (item) =>
      `| \`${item.acId}\` | ${item.description} | \`${item.testFile}\` | \`${item.testCaseName}\` | ${item.passed ? "PASS ✅" : "FAIL ❌"} |`,
  );
  return [...header, ...rows].join("\n");
}

/**
 * Render a structured, durable PR comment for an accepted finding.
 * Attributed to Eve (orchestrator), preserving reasoning for the human reviewer.
 */
export function renderAcceptedFindingComment(
  finding: ReviewFinding,
  explanation: string,
): string {
  const location =
    finding.file && finding.line
      ? ` (\`${finding.file}#${finding.line}\`)`
      : finding.file
        ? ` (\`${finding.file}\`)`
        : "";

  return [
    "🤖 **Eve** (Dark Factory) — Finding Accepted",
    "",
    `- **Finding ID**: \`${finding.id}\``,
    `- **Source**: \`${finding.source}\`${location}`,
    `- **Finding**: ${finding.message}`,
    `- **Disposition**: Accepted by Developer Agent`,
    `- **Rationale**:`,
    `  > ${explanation.trim()}`,
    "",
    "_Note: The human reviewer retains final call at merge time._",
  ].join("\n");
}

/** How the pull request s checks stand when sign-off is asked for. */
export interface SignOffChecks {
  passing: number;
  failing: number;
  pending: number;
  /** Names of the failing checks, so the message can say WHICH one, not just that one failed. */
  failingNames?: readonly string[];
}

/**
 * #759: the comment a delivered run posts when it wants sign-off.
 *
 * This is the sign-off request, and it must read as one. It says the work is complete, names the pull
 * request, says what the checks are doing, and asks for the two words that decide the matter. It must never
 * describe a plan being built or a pipeline being dispatched: a finished issue told that a new process is
 * starting is the report this answers.
 */
export function renderSignOffComment(_args: {
  prNumber: number;
  prUrl: string;
  checks?: SignOffChecks;
}): string {
  throw new Error("renderSignOffComment is not implemented");
}
