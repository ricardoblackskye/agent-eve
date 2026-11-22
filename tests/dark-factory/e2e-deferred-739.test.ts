import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decideGate, formatTestVerdict } from "../../agent/lib/dark-factory/developer-agent";

const runnerSrc = readFileSync(
  new URL("../../scripts/dark-factory-runner.ts", import.meta.url),
  "utf8",
);

describe("#739 the e2e leaves the sandbox", () => {
  it("never runs the target's e2e inside the sandbox", () => {
    // Acceptance 1. The declared suite now runs on the PR, where the DoD reads it.
    expect(runnerSrc).not.toContain("runDeclaredE2e");
  });

  it("passes the gate on the unit tier alone", () => {
    // The e2e contributes no status to the decision, so it cannot veto a green unit run.
    expect(decideGate(true).gatePassed).toBe(true);
    expect(decideGate(false).gatePassed).toBe(false);
  });

  it("names the e2e as DEFERRED, not as a missing suite", () => {
    const verdict = formatTestVerdict(true, { ran: ["unit"] }, "deferred");
    expect(verdict).toContain("deferred");
    expect(verdict).toMatch(/PR/);
    // "NOT run" would make a deliberate deferral indistinguishable from a gap in coverage.
    expect(verdict).not.toContain("NOT run");
  });

  it("still reports a failed unit run as a failure", () => {
    const verdict = formatTestVerdict(false, { ran: ["unit"] }, "deferred");
    expect(verdict).toContain("FAIL");
  });
});
