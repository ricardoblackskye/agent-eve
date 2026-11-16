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
    // #659: the status now FOLLOWS the verdict - a blocked Definition of Done still leaves a PR behind,
    // so asserting "succeeded" unconditionally recorded success for a run that refused to finish. The
    // guard's purpose is unchanged: finalised ONCE, on the DoD path, and the call carries `dodResult`.
    const finalised =
      source.match(/terminalStatus:\s*dodResult\.ok\s*\?\s*"succeeded"\s*:\s*"failed"/g) ?? [];
    expect(finalised).toHaveLength(1);
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