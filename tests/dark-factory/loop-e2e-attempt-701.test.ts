import { describe, expect, it, vi } from "vitest";
import { runDeclaredE2e } from "../../agent/lib/dark-factory/developer-agent";

/**
 * #701 — the loop runs the target's e2e suite, and classifies what happened honestly.
 *
 * Today the loop verifies with the target's unit tests only, so a PR is opened green-by-the-loop and red in
 * CI. These cases pin the three outcomes that matter, and the distinction between them is the point:
 * a suite that FAILS is the developer's problem, and a suite that cannot START is ours.
 */
const ALLOWED = ["npm test", "npm run test:e2e"];

describe("#701 running the target's declared e2e", () => {
  it("passes when the declared suite passes, carrying its output", async () => {
    const runTests = vi.fn().mockResolvedValue({ passed: true, output: "42 passed", ran: true });

    const outcome = await runDeclaredE2e({
      runTests,
      command: "npm run test:e2e",
      allowedCommands: ALLOWED,
    });

    expect(outcome.status).toBe("passed");
    expect(outcome.output).toContain("42 passed");
    // The command must be authorised for this run - the loop does not widen its own blast radius (#437).
    expect(runTests).toHaveBeenCalledWith("npm run test:e2e", { allowedCommands: ALLOWED });
  });

  it("fails when the declared suite fails, carrying the output the model must act on", async () => {
    const runTests = vi.fn().mockResolvedValue({
      passed: false,
      output: "1 failed | 41 passed  > strict mode violation: found 2 elements with <footer>",
      ran: true,
    });

    const outcome = await runDeclaredE2e({
      runTests,
      command: "npm run test:e2e",
      allowedCommands: ALLOWED,
    });

    expect(outcome.status).toBe("failed");
    // Without the output in the feedback the model cannot fix what it cannot see.
    expect(outcome.output).toContain("strict mode violation");
  });

  it("reports not-run when the target declares no e2e, without invoking anything", async () => {
    const runTests = vi.fn();

    const outcome = await runDeclaredE2e({
      runTests,
      command: undefined,
      allowedCommands: ALLOWED,
    });

    expect(outcome.status).toBe("not-run");
    expect(runTests).not.toHaveBeenCalled();
  });

  it("reports not-run when the command cannot START, which is not a failure of the developer's work", async () => {
    const runTests = vi.fn().mockResolvedValue({ passed: false, output: "spawn failed", ran: false });

    const outcome = await runDeclaredE2e({
      runTests,
      command: "npm run test:e2e",
      allowedCommands: ALLOWED,
    });

    expect(outcome.status).toBe("not-run");
    expect(outcome.output).toContain("spawn failed");
  });
});
