import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRunFindings } from "../../agent/lib/dark-factory/definition-of-done";

describe("#739 draft PR and the unsettled-check rule", () => {
  it("opens the pull request as a DRAFT (Q1)", () => {
    const prWriter = readFileSync(
      new URL("../../agent/lib/dark-factory/pr-writer.ts", import.meta.url),
      "utf8",
    );
    // A run whose checks are still running must not read as a merge proposal.
    expect(prWriter).toContain("draft: true");
  });

  it("treats an unresolved check as an ERROR, not a pass (Q2: wait for CI)", () => {
    const pending = checkRunFindings([
      {
        name: "e2e",
        status: "in_progress",
        conclusion: null,
        annotations: [],
      },
    ]);
    expect(pending.map((f) => f.id)).toContain("PR-CHECK-UNSETTLED:e2e");
    // Fail-closed: an unfinished check blocks `done` rather than being waved through.
    expect(pending.every((f) => f.severity === "error")).toBe(true);
  });

  it("keeps a completed-failed check distinct from an unsettled one", () => {
    const failed = checkRunFindings([
      {
        name: "e2e",
        status: "completed",
        conclusion: "failure",
        annotations: [],
      },
    ]);
    expect(failed.map((f) => f.id)).toContain("PR-CHECK-FAILED:e2e");
    expect(failed.map((f) => f.id).some((id) => id.startsWith("PR-CHECK-UNSETTLED"))).toBe(false);
  });
});
