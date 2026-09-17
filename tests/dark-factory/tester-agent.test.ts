import { describe, it, expect } from "vitest";
import {
  toValidationRequest,
  type ValidationRequest,
  type ValidationReport,
  type PassFail,
  ValidationError,
  ValidationFailedError,
  createTesterAgent,
  TesterAgent,
  parseErrorOutput,
} from "../../agent/lib/dark-factory/tester-agent";

// --- Task 136.1: Validation types + ValidationRequest payload ---

describe("toValidationRequest", () => {
  it("creates valid request with branch name", () => {
    const req = toValidationRequest({ branch: "feature/test" });
    expect(req.branch).toBe("feature/test");
    expect(req.targetSha).toBeUndefined();
    expect(req.env).toBeUndefined();
  });

  it("creates valid request with targetSha", () => {
    const req = toValidationRequest({ branch: "fix/bug", targetSha: "abc123" });
    expect(req.branch).toBe("fix/bug");
    expect(req.targetSha).toBe("abc123");
  });

  it("creates valid request with custom env", () => {
    const env = { DF_TIMEOUT_MS: "30000" };
    const req = toValidationRequest({ branch: "test", env });
    expect(req.env).toBe(env);
  });

  it("rejects missing branch", () => {
    expect(() => toValidationRequest({ branch: undefined as any })).toThrow(ValidationError);
  });

  it("rejects empty branch", () => {
    expect(() => toValidationRequest({ branch: "" })).toThrow(ValidationError);
  });

  it("rejects whitespace-only branch", () => {
    expect(() => toValidationRequest({ branch: "   " })).toThrow(ValidationError);
  });
});

// --- Task 136.2: Static analysis runner ---

describe("static analysis runner", () => {
  it("delegates to runCommand for tsc and cspell via execFile args", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 60000 });

    const calls: Array<{ cmd: string; args: string[] }> = [];
    (agent as any).runCommand = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await (agent as any).runStaticAnalysis();
    expect(calls[0]).toEqual({ cmd: "npx", args: ["tsc", "--noEmit"] });
    expect(calls[1]).toEqual({
      cmd: "npx",
      args: ["cspell", "agent/lib/dark-factory/*.ts", "tests/dark-factory/*.test.ts"],
    });
  });

  it("returns pass when no errors", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 60000 });
    (agent as any).runCommand = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const result: PassFail = await (agent as any).runStaticAnalysis();
    expect(result.status).toBe("pass");
  });

  it("returns fail with errors when tsc reports errors", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 60000 });
    (agent as any).runCommand = async (cmd: string, args: string[]) => {
      if (args.includes("tsc")) {
        return { exitCode: 2, stdout: "error TS2345: type mismatch", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result: PassFail = await (agent as any).runStaticAnalysis();
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.errors).toContain("error TS2345: type mismatch");
    }
  });

  it("returns fail with errors when cspell reports errors", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 60000 });
    (agent as any).runCommand = async (cmd: string, args: string[]) => {
      if (args.includes("cspell")) {
        return { exitCode: 1, stdout: "", stderr: "Unknown word (foobar)" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result: PassFail = await (agent as any).runStaticAnalysis();
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.errors).toContain("Unknown word (foobar)");
    }
  });

  it("aggregates errors from both tsc and cspell", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 60000 });
    (agent as any).runCommand = async (cmd: string, args: string[]) => {
      if (args.includes("tsc")) {
        return { exitCode: 2, stdout: "tsc error", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "cspell error" };
    };
    const result: PassFail = await (agent as any).runStaticAnalysis();
    if (result.status === "fail") {
      expect(result.errors).toContain("tsc error");
      expect(result.errors).toContain("cspell error");
    } else {
      throw new Error("expected fail");
    }
  });
});

// --- Task 136.3: Smoke test runner ---

describe("smoke test runner", () => {
  it("delegates to runCommand for vitest via execFile args", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 60000 });

    let capturedArgs: string[] = [];
    (agent as any).runCommand = async (cmd: string, args: string[]) => {
      capturedArgs = args;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    await (agent as any).runSmokeTests();
    expect(capturedArgs).toEqual(["vitest", "run", "--passWithNoTests"]);
  });

  it("returns pass when vitest succeeds", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 60000 });
    (agent as any).runCommand = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const result: PassFail = await (agent as any).runSmokeTests();
    expect(result.status).toBe("pass");
  });

  it("returns fail with errors when vitest fails", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 60000 });
    (agent as any).runCommand = async () => ({
      exitCode: 1,
      stdout: "FAIL tests/foo.test.ts",
      stderr: "1 test failed",
    });
    const result: PassFail = await (agent as any).runSmokeTests();
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.errors).toContain("FAIL tests/foo.test.ts");
    }
  });

  it("uses 3x timeout for tests", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 60000 });
    let capturedTimeout = 0;
    (agent as any).runCommand = async (cmd: string, args: string[], timeout: number) => {
      capturedTimeout = timeout;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await (agent as any).runSmokeTests();
    expect(capturedTimeout).toBe(180000);
  });
});

// --- Task 136.4: Security scan integration ---

describe("security scan", () => {
  it("returns pass when security scan is disabled", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ enableSecurityScan: false });
    const result: PassFail = await (agent as any).runSecurityScan();
    expect(result.status).toBe("pass");
  });

  it("returns pass when gitleaks finds no secrets", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ enableSecurityScan: true });
    (agent as any).runCommand = async () => ({ exitCode: 0, stdout: "No leaks", stderr: "" });
    const result: PassFail = await (agent as any).runSecurityScan();
    expect(result.status).toBe("pass");
  });

  it("returns fail with errors when gitleaks finds secrets", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ enableSecurityScan: true });
    (agent as any).runCommand = async () => ({
      exitCode: 1,
      stdout: "leak found in .env:5",
      stderr: "",
    });
    const result: PassFail = await (agent as any).runSecurityScan();
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.errors).toContain("leak found in .env:5");
    }
  });

  it("runs gitleaks with explicit args when enabled", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ enableSecurityScan: true });
    let captured: { cmd: string; args: string[] } | null = null;
    (agent as any).runCommand = async (cmd: string, args: string[]) => {
      captured = { cmd, args };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await (agent as any).runSecurityScan();
    expect(captured).toEqual({ cmd: "npx", args: ["gitleaks", "protect", "--verbose"] });
  });
});

// --- Task 136.5: Validation orchestration (runValidation integration) ---

describe("runValidation orchestration", () => {
  it("runs all checks and returns pass when all succeed", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ enableSecurityScan: true, checkTimeoutMs: 5000 });
    (agent as any).runCommand = async () => ({ exitCode: 0, stdout: "", stderr: "" });

    const report: ValidationReport = await agent.runValidation(
      toValidationRequest({ branch: "feature/x" }),
    );
    expect(report.staticAnalysis.status).toBe("pass");
    expect(report.smokeTests.status).toBe("pass");
    expect(report.securityScan.status).toBe("pass");
    expect(report.overall).toBe("pass");
    expect(report.branch).toBe("feature/x");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("blocks PR when static analysis fails", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ enableSecurityScan: true, checkTimeoutMs: 5000 });
    (agent as any).runCommand = async (cmd: string, args: string[]) => {
      if (args.includes("tsc")) {
        return { exitCode: 2, stdout: "tsc error", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const report: ValidationReport = await agent.runValidation(
      toValidationRequest({ branch: "feature/x" }),
    );
    expect(report.staticAnalysis.status).toBe("fail");
    expect(report.overall).toBe("fail");
  });

  it("blocks PR when smoke tests fail", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ enableSecurityScan: true, checkTimeoutMs: 5000 });
    (agent as any).runCommand = async (cmd: string, args: string[]) => {
      if (args.includes("vitest")) {
        return { exitCode: 1, stdout: "test failed", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const report: ValidationReport = await agent.runValidation(
      toValidationRequest({ branch: "feature/x" }),
    );
    expect(report.smokeTests.status).toBe("fail");
    expect(report.overall).toBe("fail");
  });

  it("blocks PR when security scan fails", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ enableSecurityScan: true, checkTimeoutMs: 5000 });
    (agent as any).runCommand = async (cmd: string, args: string[]) => {
      if (args.includes("gitleaks")) {
        return { exitCode: 1, stdout: "secret leaked", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const report: ValidationReport = await agent.runValidation(
      toValidationRequest({ branch: "feature/x" }),
    );
    expect(report.securityScan.status).toBe("fail");
    expect(report.overall).toBe("fail");
  });

  it("skips security scan when disabled", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ enableSecurityScan: false, checkTimeoutMs: 5000 });
    let gitleaksCalled = false;
    (agent as any).runCommand = async (cmd: string, args: string[]) => {
      if (args.includes("gitleaks")) gitleaksCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const report: ValidationReport = await agent.runValidation(
      toValidationRequest({ branch: "feature/x" }),
    );
    expect(gitleaksCalled).toBe(false);
    expect(report.securityScan.status).toBe("pass");
    expect(report.overall).toBe("pass");
  });
});

// --- Configuration validation (createTesterAgent) ---

describe("createTesterAgent config validation", () => {
  it("uses defaults when env is empty", () => {
    const agent = createTesterAgent({});
    expect(agent).toBeInstanceOf(TesterAgent);
  });

  it("reads DF_SECURITY_SCAN_ENABLED=true", () => {
    const agent = createTesterAgent({ DF_SECURITY_SCAN_ENABLED: "true" });
    expect(agent).toBeInstanceOf(TesterAgent);
  });

  it("throws ValidationError on invalid DF_TESTER_TIMEOUT_MS", () => {
    expect(() => createTesterAgent({ DF_TESTER_TIMEOUT_MS: "abc" })).toThrow(ValidationError);
  });

  it("throws ValidationError on zero timeout", () => {
    expect(() => createTesterAgent({ DF_TESTER_TIMEOUT_MS: "0" })).toThrow(ValidationError);
  });

  it("throws ValidationError on negative timeout", () => {
    expect(() => createTesterAgent({ DF_TESTER_TIMEOUT_MS: "-5" })).toThrow(ValidationError);
  });

  it("accepts valid positive integer timeout", () => {
    const agent = createTesterAgent({ DF_TESTER_TIMEOUT_MS: "30000" });
    expect(agent).toBeInstanceOf(TesterAgent);
  });

  it("accepts DF_TESTER_TIMEOUT_MS unset (default)", () => {
    const agent = createTesterAgent({});
    expect(agent).toBeInstanceOf(TesterAgent);
  });
});

// --- ValidationFailedError message completeness ---

describe("ValidationFailedError", () => {
  it("includes all failed check details in message", () => {
    const report: ValidationReport = {
      staticAnalysis: { status: "fail", errors: ["tsc error"] },
      smokeTests: { status: "fail", errors: ["vitest error"] },
      securityScan: { status: "pass" },
      overall: "fail",
      timestamp: new Date().toISOString(),
      branch: "feature/x",
      durationMs: 100,
    };
    const err = new ValidationFailedError(report);
    expect(err.message).toContain("tsc error");
    expect(err.message).toContain("vitest error");
    expect(err.report).toBe(report);
  });

  it("includes security scan errors when present", () => {
    const report: ValidationReport = {
      staticAnalysis: { status: "pass" },
      smokeTests: { status: "pass" },
      securityScan: { status: "fail", errors: ["gitleaks error"] },
      overall: "fail",
      timestamp: new Date().toISOString(),
      branch: "feature/x",
      durationMs: 100,
    };
    const err = new ValidationFailedError(report);
    expect(err.message).toContain("gitleaks error");
  });
});

// --- parseErrorOutput edge cases ---

describe("parseErrorOutput", () => {
  it("returns [] for empty string", () => {
    expect(parseErrorOutput("")).toEqual([]);
  });

  it("drops whitespace-only lines", () => {
    expect(parseErrorOutput("  \n\t\n  ")).toEqual([]);
  });

  it("trims and filters non-empty lines", () => {
    expect(parseErrorOutput("  a  \n\n  b  \n")).toEqual(["a", "b"]);
  });

  it("handles single line without trailing newline", () => {
    expect(parseErrorOutput("error: x")).toEqual(["error: x"]);
  });
});

// --- runCommand error preservation ---

describe("runCommand error preservation", () => {
  it("preserves exit code and partial output on failure", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 5000 });
    (agent as any).runCommand = async () => ({
      exitCode: 127,
      stdout: "partial output",
      stderr: "command not found",
    });
    const result = await (agent as any).runCommand("npx", ["tsc"], 5000);
    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("partial output");
    expect(result.stderr).toBe("command not found");
  });
});
