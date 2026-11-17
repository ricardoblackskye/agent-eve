/**
 * #284 — the runner must drive the terminal-lifecycle finalizer.
 *
 * The runner is an out-of-band script (not exercised by the webhook unit suites) and
 * makes real GitHub calls, so this test guards the WIRING at the source level: the
 * finalizer is imported and invoked on the success path AND on every terminal-failure
 * path, and the old inline `df:done` write is gone. Behaviour itself is covered by
 * run-finalizer.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(process.cwd(), "scripts/dark-factory-runner.ts"),
  "utf8",
);

describe("#284 runner wires the terminal-lifecycle finalizer", () => {
  it("adapts the issue writer to the LabelWriter seam", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*createGitHubLabelWriter[^}]*\}\s*from\s*"[^"]*issue-writer"/,
    );
    expect(source).toMatch(/createGitHubLabelWriter\(issueWriter\)/);
  });

  it("imports applyTerminalLifecycle from the finalizer module", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*applyTerminalLifecycle[^}]*\}\s*from\s*"[^"]*run-finalizer"/,
    );
  });

  it("finalises the run exactly once on the DoD path, carrying the verdict", () => {
    // #659: the status FOLLOWS the verdict - a blocked DoD still leaves a PR behind, so asserting
    // "succeeded" unconditionally recorded success for a run that refused to finish.
    // #672 CORRECTION: this guard previously pinned the exact ternary, and I loosened it to
    // "derived from the verdict" - which let a real defect through. The event's status vocabulary is
    // TERMINAL ONLY (run-history.ts: TERMINAL_STATUSES = aborted | succeeded | failed), because a
    // BLOCKED run is resumable, not finished. Passing the DoD verdict through raw produced `blocked`,
    // the run-history validator rejected the run.terminal event, and the top-level catch then stacked
    // df:failed on top of df:blocked on the ticket.
    //
    // So it is deliberately not loose here: the status must be derived from the verdict AND must
    // never carry a non-terminal value. A live run found this; the unit tests did not.
    const dodCallSites = source.match(/terminalStatus:[^;]*dodResult\.ok[^;]*/g) ?? [];
    expect(dodCallSites).toHaveLength(1);
    expect(dodCallSites[0]).not.toMatch(/"blocked"/);
    expect(dodCallSites[0]).toMatch(/"succeeded"/);
    expect(dodCallSites[0]).toMatch(/"failed"/);
    expect(source).toMatch(/dodResult,/);
  });

  it("finalises the run as failed at every terminal-failure path", () => {
    const failed = source.match(/terminalStatus:\s*"failed"/g) ?? [];
    // architect plan fail · domain validation fail · dev-loop fail · push fail
    expect(failed.length).toBeGreaterThanOrEqual(4);
  });

  it("no longer writes the terminal lifecycle label inline", () => {
    expect(source).not.toMatch(/addLabel\([^)]*"df:done"/);
    expect(source).not.toMatch(/removeLabel\([^)]*"df:running"/);
  });
});

/**
 * #659 - the DoD's check wait is a single budget, not one per review round.
 *
 * `runChecks` is called once per round. Passing the full timeout each time meant a blocked run against a
 * slow CI spent 10 minutes per round waiting for checks that had already concluded - measured at ~25
 * minutes of silence on one run. One deadline, consumed across the rounds.
 */
describe("#659 the check wait is bounded once across the review rounds", () => {
  it("derives each round's wait from a single deadline", () => {
    expect(source).toMatch(/checkWaitDeadline/);
    expect(source).toMatch(/timeoutMs:\s*Math\.max\(\s*0\s*,\s*checkWaitDeadline\s*-\s*Date\.now\(\)\s*\)/);
  });
});
