/**
 * #492 — planning usage must reach the ledger with its own task type, and ONLY the architect call may supply a
 * sink: the developer and tester paths keep writing exactly what they wrote before (AC3).
 *
 * The runner is out of band — it makes real GitHub calls and no unit test executes it — so its WIRING is guarded at
 * the source, which is the repo's convention for composition-root seams. Each assertion is scoped to the specific
 * call site it is about, so a sibling call cannot satisfy it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RUNNER = readFileSync(join(process.cwd(), "scripts", "dark-factory-runner.ts"), "utf8");

/** Every `runGovernedAgentCall(` call site, split so one call's text cannot satisfy another's assertion. */
function governedCallSites(source: string): string[] {
  return source.split("runGovernedAgentCall(").slice(1);
}

describe("#492 the architect call is wired to the usage ledger", () => {
  it("builds an opt-in recorder with the worker-usage factory", () => {
    expect(RUNNER).toContain("createWorkerUsageRecorder(");
    // The factory returns null when DF_USAGE_DRIVER is unset, which IS the opt-in: an unconfigured
    // deployment records nothing and behaves exactly as before.
    expect(RUNNER).toMatch(/createWorkerUsageRecorder\(\s*process\.env/);
  });

  it("supplies a sink tagged architect on the architect call, and on no other call", () => {
    const sites = governedCallSites(RUNNER);
    // Non-vacuity: if the call sites ever move or rename, this must fail here rather than pass by finding nothing.
    expect(sites.length).toBeGreaterThanOrEqual(2);

    const architect = sites.filter((site) => site.includes('category: "architect"'));
    expect(architect).toHaveLength(1);
    expect(architect[0]).toContain('taskType: "architect"');
    expect(architect[0]).toContain("sink");

    // AC3: developer and tester counts must not change, so no other call site may supply a usage sink.
    const others = sites.filter((site) => !site.includes('category: "architect"'));
    expect(others.length).toBeGreaterThan(0);
    for (const site of others) {
      expect(site, "only the architect call may supply a usage sink").not.toContain("usage:");
    }
  });

  it("measures from the provider's own usage and still hands the agent its text", () => {
    const architect = governedCallSites(RUNNER).find((site) => site.includes('category: "architect"'));
    expect(architect).toBeDefined();
    expect(architect).toContain("measurementOf");
    // The measurement is the provider's, not an estimate: this is the stream result the runner already consumes.
    expect(RUNNER).toContain("stream.usage");
  });
});
