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
    ...(finding.classification
      ? [
          `- **Cause**: ${finding.classification.cause} - owner ${finding.classification.owner}`,
          ...(finding.classification.evidence
            ? [`- **Evidence**: ${finding.classification.evidence}`]
            : []),
        ]
      : []),
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
/** What the checks are doing, in one line, naming the failing check when there is one. */
function renderCheckStatus(checks?: SignOffChecks): string {
  if (!checks) {
    // #764: the ABSENCE of an input is not evidence that the checks are silent. A real run's sign-off comment said
    // "The pull request checks have not reported yet." while its verdict was `done` and all six checks had already
    // completed green - the operator surface misstating the state it exists to report. Saying nothing is permitted;
    // asserting an unobserved state is not, which is the same false certification as the issue, one layer down.
    return "";
  }

  const parts: string[] = [];
  if (checks.passing > 0) parts.push(`${checks.passing} passing`);
  if (checks.pending > 0) parts.push(`${checks.pending} pending`);
  if (checks.failing > 0) parts.push(`${checks.failing} failing`);
  const summary = parts.length > 0 ? parts.join(", ") : "none reported";

  if (checks.failing > 0) {
    const names = (checks.failingNames ?? []).map((name) => `\`${name}\``).join(", ");
    return names.length > 0
      ? `The pull request checks: ${summary} - the failing check is ${names}.`
      : `The pull request checks: ${summary}.`;
  }

  return `The pull request checks: ${summary}.`;
}

export function renderSignOffComment(args: {
  prNumber: number;
  prUrl: string;
  checks?: SignOffChecks;
}): string {
  return [
    "### Ready for sign-off",
    "",
    "The work is complete and its pull request is open: " +
      `[#${args.prNumber}](${args.prUrl}).`,
    "",
    renderCheckStatus(args.checks),
    "",
    "Reply **Approved** to sign this off, or **Rejected** to close the pull request and return the" +
      " issue for re-planning.",
  ].join("\n");
}
