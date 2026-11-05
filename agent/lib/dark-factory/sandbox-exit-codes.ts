/**
 * #585 T3 (AC2) — the documented exit-code table for the sandbox CLI.
 *
 * WHY THIS EXISTS: every provisioning failure used to exit 1. On Windows a helm cache
 * failure and a vault failure were indistinguishable, so the GUI (#582) could only say
 * "provisioning failed" without telling the operator what to do. A stable table lets a
 * caller branch on the number: fix the invocation (2), install a prerequisite (10), run
 * the vendor step (11), check Docker/minikube (12), inspect cluster logs (13), clean up
 * by hand (14).
 *
 * The numbers live in one exported const so the CLI, the tests and the docs cannot drift.
 * 2 is deliberately absent: a usage error is raised by flag parsing before provisioning
 * runs, so no ProvisionProblemCode may map to it.
 */
import type { ProvisionProblemCode, ProvisionResult } from "./sandbox-provisioning";

/** Every process exit code the sandbox command may return. */
export type ExitCode = 0 | 1 | 10 | 11 | 12 | 13 | 14 | 15;

/** Stable mapping. Exported so the doc-drift guard can compare the docs to the table. */
export const EXIT_CODES: Record<ProvisionProblemCode, ExitCode> = {
  "prerequisites-missing": 10,
  "prerequisites-mismatch": 15,
  "artifact-unresolvable": 11,
  "cluster-unreachable": 12,
  "proof-failed": 13,
  "teardown-failed": 14,
  internal: 1,
};

/** The exit code for one classified failure. */
export function exitCodeForProblem(code: ProvisionProblemCode): ExitCode {
  return EXIT_CODES[code] ?? 1;
}

/**
 * The exit code for a whole result: 0 when provisioned and proven, otherwise the first
 * problem's code. An unclassified failure (no problems) falls back to 1.
 */
export function exitCodeForResult(result: ProvisionResult): ExitCode {
  if (result.ok) return 0;
  return exitCodeForProblem(result.problems[0]?.code ?? "internal");
}
