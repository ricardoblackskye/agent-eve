import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-level guard for the runner's WIRING (#316), in the style established by
 * `run-finalizer-wiring.test.ts`: the runner is an out-of-band script, so its call sites and
 * their ORDER are pinned here while the behaviour lives in `run-record.ts`'s unit tests.
 */
const RUNNER = join(process.cwd(), "scripts", "dark-factory-runner.ts");

describe("runner records its run (#316)", () => {
  const source = readFileSync(RUNNER, "utf8");

  it("opens the run record through the seam", () => {
    expect(source).toContain('from "../agent/lib/dark-factory/run-record"');
    expect(source).toContain("beginRunRecord(");
  });

  it("adopts the run id the start DECISION chose, for everything downstream", () => {
    // #373: the decision is what separates starting from continuing. On a fresh run that is the id the ledger
    // minted; on a resume against a parked (blocked) holder it is THAT run's id - which is what makes the
    // resumed run's lifecycle writes land on the real run instead of a phantom run id.
    expect(source).toContain("const startDecision = decideRunStart(begun");
    expect(source).toContain("const runId = startDecision.runId;");
  });

  it("resolves the runner's own id as the ATTEMPT identity, not the run id", () => {
    expect(source).toContain("const attemptId = resolveRunnerRunId(");
  });

  it("accepts the run BEFORE the control store is built, so control actions address it", () => {
    const acceptAt = source.indexOf("beginRunRecord(");
    const controlAt = source.indexOf("buildRunControl(env, runId)");
    expect(acceptAt).toBeGreaterThan(-1);
    expect(controlAt).toBeGreaterThan(-1);
    expect(acceptAt).toBeLessThan(controlAt);
  });

  it("does not construct the run-history store twice", () => {
    const constructions = source.match(/createRunHistoryStore\(/g) ?? [];
    expect(constructions).toHaveLength(1);
  });
});
