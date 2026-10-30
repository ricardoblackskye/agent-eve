/**
 * #560 — the Tester's own roadblock: a command its guard refuses.
 *
 * `defaultCommandRunner` permits only `npx` with `{ tsc, cspell, vitest, gitleaks }` and throws
 * `ValidationError` for anything else. The runner is INJECTED into `TesterAgent`, so the capture
 * wraps it: a refusal is reported through an optional tap and then propagates exactly as before.
 *
 * Note the fixture: `runValidation`'s own checks issue allow-listed commands, so a refusal is
 * exercised through the injected seam a caller supplies - which is what the tap exists for. The
 * stub throws the REAL refusal message so the case is not testing an invented contract.
 */
import { describe, expect, it, vi } from "vitest";
import {
  TesterAgent,
  ValidationError,
  type CommandRunner,
} from "../../agent/lib/dark-factory/tester-agent";

const REFUSAL =
  "Command not allowed: npx rm -rf /. Only npx with whitelisted commands (tsc, cspell, vitest, gitleaks) are permitted.";

function refusingRunner(): CommandRunner {
  return async () => {
    throw new ValidationError(REFUSAL);
  };
}

describe("the Tester surfaces a refused command (#560)", () => {
  it("hands the refusal to the caller's tap, once, and still throws", async () => {
    const onRefusedCommand = vi.fn();
    const tester = new TesterAgent({}, {
      commandRunner: refusingRunner(),
      onRefusedCommand,
    });

    // The refusal must STILL reach the caller: the capture is an addition, not a replacement.
    await expect(tester.runValidation({ branch: "feat/x" })).rejects.toThrow(
      /Command not allowed/i,
    );

    expect(onRefusedCommand).toHaveBeenCalledTimes(1);
    const info = onRefusedCommand.mock.calls[0][0];
    expect(info.command).toBe("npx");
    expect(Array.isArray(info.args)).toBe(true);
    expect(info.reason).toMatch(/Command not allowed/i);
  });

  it("works when no tap is supplied", async () => {
    // The option is optional: existing callers must keep compiling and behaving.
    const tester = new TesterAgent({}, { commandRunner: refusingRunner() });
    await expect(tester.runValidation({ branch: "feat/x" })).rejects.toThrow(
      /Command not allowed/i,
    );
  });

  it("CONTROL: a plain failing command is not a refusal", async () => {
    // A command that RUNS and fails is a normal result, not a roadblock. Without this case a tap
    // that fired on any error would satisfy the suite.
    const onRefusedCommand = vi.fn();
    const failingRunner: CommandRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "some real compile error",
    });
    const tester = new TesterAgent({}, {
      commandRunner: failingRunner,
      onRefusedCommand,
    });

    const report = await tester.runValidation({ branch: "feat/x" });

    expect(onRefusedCommand).not.toHaveBeenCalled();
    expect(report.overall).toBe("fail");
  });

  it("CONTROL: a passing validation is not a refusal", async () => {
    const onRefusedCommand = vi.fn();
    const passingRunner: CommandRunner = async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    const tester = new TesterAgent({}, {
      commandRunner: passingRunner,
      onRefusedCommand,
    });

    const report = await tester.runValidation({ branch: "feat/x" });

    expect(onRefusedCommand).not.toHaveBeenCalled();
    expect(report.overall).toBe("pass");
  });
});
