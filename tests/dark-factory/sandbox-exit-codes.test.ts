/**
 * #585 T3 (AC2) — the exit-code table.
 *
 * The defect this closes: every failure exited 1. A helm cache failure, a vault failure
 * and an unknown flag all looked identical to a caller, so the GUI (#582) could only say
 * "provisioning failed" without telling the operator what to do. A stable table lets the
 * caller branch: fix the invocation (2), install a prerequisite (10), run the vendor step
 * (11), check Docker/minikube (12), inspect cluster logs (13), clean up by hand (14).
 *
 * The table is asserted here, and the CLI's use of it is asserted in the wiring test.
 * These are unit tests: no cluster, no Docker, no process spawn.
 */
import { describe, expect, it } from "vitest";
import {
  EXIT_CODES,
  exitCodeForProblem,
  exitCodeForResult,
  type ExitCode,
} from "../../agent/lib/dark-factory/sandbox-exit-codes";
import type { ProvisionProblemCode } from "../../agent/lib/dark-factory/sandbox-provisioning";

describe("the exit-code table (#585 T3 / AC2)", () => {
  // The plan's documented table. If a code changes here without the docs changing,
  // the doc-drift guard catches it — that is why the numbers live in one exported const.
  const cases: [ProvisionProblemCode, ExitCode][] = [
    ["prerequisites-missing", 10],
    ["artifact-unresolvable", 11],
    ["cluster-unreachable", 12],
    ["proof-failed", 13],
    ["teardown-failed", 14],
    ["internal", 1],
  ];

  it.each(cases)("maps %s to exit code %i", (code, expected) => {
    expect(exitCodeForProblem(code)).toBe(expected);
  });

  it("covers every ProvisionProblemCode: no code falls through to the default", () => {
    const codes: ProvisionProblemCode[] = [
      "prerequisites-missing",
      "artifact-unresolvable",
      "cluster-unreachable",
      "proof-failed",
      "teardown-failed",
      "internal",
    ];
    // A code with no explicit entry would silently take the internal fallback and lose
    // its documented meaning. The count check makes adding a code without a mapping fail.
    expect(Object.keys(EXIT_CODES).sort()).toEqual([...codes].sort());
  });

  it("maps a successful result to 0", () => {
    expect(
      exitCodeForResult({ ok: true, endpoint: "http://localhost:18082", problems: [] }),
    ).toBe(0);
  });

  it("maps a failed result to the first problem's code", () => {
    expect(
      exitCodeForResult({
        ok: false,
        endpoint: "http://localhost:18082",
        problems: [
          {
            code: "proof-failed",
            subject: "the vault proof failed",
            fix: "inspect cluster logs",
          },
        ],
      }),
    ).toBe(13);
  });

  it("falls back to 1 for an unclassified failure", () => {
    expect(
      exitCodeForResult({
        ok: false,
        endpoint: "http://localhost:18082",
        problems: [],
      }),
    ).toBe(1);
  });

  it("reserves 2 for usage errors and never returns it from a provision result", () => {
    // Usage errors are raised by flag parsing before provisioning runs, so no
    // ProvisionProblemCode may map to 2.
    expect(Object.values(EXIT_CODES)).not.toContain(2);
  });

  it("uses only the documented numbers", () => {
    const documented = new Set([1, 10, 11, 12, 13, 14]);
    for (const code of Object.values(EXIT_CODES)) {
      expect(documented.has(code)).toBe(true);
    }
  });
});
