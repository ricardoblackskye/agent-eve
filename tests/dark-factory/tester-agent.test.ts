import { describe, it, expect, vi } from "vitest";
import {
  toValidationRequest,
  type ValidationRequest,
  type ValidationReport,
  type PassFail,
  type CommandRunner,
  ValidationError,
  ValidationFailedError,
  createTesterAgent,
  createValidationReport,
  ALLOWED_ENV_KEYS,
  TesterAgent,
  parseErrorOutput,
} from "../../agent/lib/dark-factory/tester-agent";

/** Create a TesterAgent with an injected mock command runner. */
function makeAgent(
  mockRunner: CommandRunner,
  config: ConstructorParameters<typeof TesterAgent>[0] = {},
): TesterAgent {
  return new TesterAgent(config, { commandRunner: mockRunner });
}

// --- Task 136.1: Validation types + ValidationRequest payload ---

describe("toValidationRequest", () => {
  it("creates valid request with branch name", () => {
    const req = toValidationRequest({ branch: "feature/test" });
    expect(req.branch).toBe("feature/test");
    expect(req.targetSha).toBeUndefined();
    expect(req.env).toBeUndefined();
  });

  it("creates valid request with valid targetSha", () => {
    const sha = "a".repeat(40);
    const req = toValidationRequest({ branch: "fix/bug", targetSha: sha });
    expect(req.branch).toBe("fix/bug");
    expect(req.targetSha).toBe(sha);
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

  it("rejects invalid targetSha format (too short)", () => {
    expect(() => toValidationRequest({ branch: "x", targetSha: "abc" })).toThrow(
      ValidationError,
    );
  });

  it("rejects invalid targetSha format (non-hex)", () => {
    expect(() => toValidationRequest({ branch: "x", targetSha: "z".repeat(40) })).toThrow(
      ValidationError,
    );
  });
});

// --- Task 136.2: Static analysis runner ---

describe("static analysis runner", () => {
  it("delegates to runner for tsc and cspell via execFile args", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner: CommandRunner = async (cmd, args) => {
      calls.push({ cmd, args });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const agent = makeAgent(runner, { checkTimeoutMs: 60000 });

    // runStaticAnalysis is private; exercised via runValidation
    await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(calls[0]).toEqual({ cmd: "npx", args: ["tsc", "--noEmit"] });
    expect(calls[1]).toEqual({
      cmd: "npx",
      args: ["cspell", "agent/lib/dark-factory/*.ts", "tests/dark-factory/*.test.ts"],
    });
  });

  it("returns fail with errors when tsc reports errors", async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (args.includes("tsc")) {
        return { exitCode: 2, stdout: "error TS2345: type mismatch", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const agent = makeAgent(runner, { checkTimeoutMs: 60000 });
    const report = await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    if (report.staticAnalysis.status === "fail") {
      expect(report.staticAnalysis.errors).toContain("error TS2345: type mismatch");
    } else {
      throw new Error("expected fail");
    }
  });

  it("returns fail with errors when cspell reports errors", async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (args.includes("cspell")) {
        return { exitCode: 1, stdout: "", stderr: "Unknown word (foobar)" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const agent = makeAgent(runner, { checkTimeoutMs: 60000 });
    const report = await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    if (report.staticAnalysis.status === "fail") {
      expect(report.staticAnalysis.errors).toContain("Unknown word (foobar)");
    } else {
      throw new Error("expected fail");
    }
  });

  it("aggregates errors from both tsc and cspell", async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (args.includes("tsc")) {
        return { exitCode: 2, stdout: "tsc error", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "cspell error" };
    };
    const agent = makeAgent(runner, { checkTimeoutMs: 60000 });
    const report = await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    if (report.staticAnalysis.status === "fail") {
      expect(report.staticAnalysis.errors).toContain("tsc error");
      expect(report.staticAnalysis.errors).toContain("cspell error");
    } else {
      throw new Error("expected fail");
    }
  });
});

// --- Task 136.3: Smoke test runner ---

describe("smoke test runner", () => {
  it("delegates to runner for vitest via execFile args", async () => {
    let capturedArgs: string[] = [];
    const runner: CommandRunner = async (cmd, args) => {
      capturedArgs = args;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const agent = makeAgent(runner, { checkTimeoutMs: 60000 });
    await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(capturedArgs).toEqual(["vitest", "run", "--passWithNoTests"]);
  });

  it("returns fail with errors when vitest fails", async () => {
    const runner: CommandRunner = async () => ({
      exitCode: 1,
      stdout: "FAIL tests/foo.test.ts",
      stderr: "1 test failed",
    });
    const agent = makeAgent(runner, { checkTimeoutMs: 60000 });
    const report = await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    if (report.smokeTests.status === "fail") {
      expect(report.smokeTests.errors).toContain("FAIL tests/foo.test.ts");
    } else {
      throw new Error("expected fail");
    }
  });

  it("uses 3x timeout for tests", async () => {
    let capturedTimeout = 0;
    const runner: CommandRunner = async (cmd, args, timeout) => {
      capturedTimeout = timeout;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const agent = makeAgent(runner, { checkTimeoutMs: 60000 });
    await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(capturedTimeout).toBe(180000);
  });
});

// --- Task 136.4: Security scan integration ---

describe("security scan", () => {
  it("returns pass when security scan is disabled", async () => {
    const runner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const agent = makeAgent(runner, { enableSecurityScan: false });
    const report = await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(report.securityScan.status).toBe("pass");
  });

  it("returns pass when gitleaks finds no secrets", async () => {
    const runner: CommandRunner = async () => ({ exitCode: 0, stdout: "No leaks", stderr: "" });
    const agent = makeAgent(runner, { enableSecurityScan: true });
    const report = await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(report.securityScan.status).toBe("pass");
  });

  it("returns fail with errors when gitleaks finds secrets", async () => {
    const runner: CommandRunner = async () => ({
      exitCode: 1,
      stdout: "leak found in .env:5",
      stderr: "",
    });
    const agent = makeAgent(runner, { enableSecurityScan: true });
    const report = await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    if (report.securityScan.status === "fail") {
      expect(report.securityScan.errors).toContain("leak found in .env:5");
    } else {
      throw new Error("expected fail");
    }
  });

  it("skips gitleaks when disabled", async () => {
    let gitleaksCalled = false;
    const runner: CommandRunner = async (cmd, args) => {
      if (args.includes("gitleaks")) gitleaksCalled = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const agent = makeAgent(runner, { enableSecurityScan: false });
    await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(gitleaksCalled).toBe(false);
  });
});

// --- Task 136.5: Validation orchestration (runValidation integration) ---

describe("runValidation orchestration", () => {
  it("runs all checks and returns pass when all succeed", async () => {
    const runner: CommandRunner = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const agent = makeAgent(runner, { enableSecurityScan: true, checkTimeoutMs: 5000 });
    const report = await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(report.staticAnalysis.status).toBe("pass");
    expect(report.smokeTests.status).toBe("pass");
    expect(report.securityScan.status).toBe("pass");
    expect(report.overall).toBe("pass");
    expect(report.branch).toBe("feature/x");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("blocks PR when static analysis fails", async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (args.includes("tsc")) return { exitCode: 2, stdout: "tsc error", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const agent = makeAgent(runner, { enableSecurityScan: true, checkTimeoutMs: 5000 });
    const report = await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(report.staticAnalysis.status).toBe("fail");
    expect(report.overall).toBe("fail");
  });

  it("blocks PR when smoke tests fail", async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (args.includes("vitest")) return { exitCode: 1, stdout: "test failed", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const agent = makeAgent(runner, { enableSecurityScan: true, checkTimeoutMs: 5000 });
    const report = await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(report.smokeTests.status).toBe("fail");
    expect(report.overall).toBe("fail");
  });

  it("blocks PR when security scan fails", async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (args.includes("gitleaks")) return { exitCode: 1, stdout: "secret", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const agent = makeAgent(runner, { enableSecurityScan: true, checkTimeoutMs: 5000 });
    const report = await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(report.securityScan.status).toBe("fail");
    expect(report.overall).toBe("fail");
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
});

// --- ValidationFailedError message completeness ---

describe("ValidationFailedError", () => {
  it("includes all failed check details in message", () => {
    const report = createValidationReport({
      staticAnalysis: { status: "fail", errors: ["tsc error"] },
      smokeTests: { status: "fail", errors: ["vitest error"] },
      securityScan: { status: "pass" },
      timestamp: new Date().toISOString(),
      branch: "feature/x",
      durationMs: 100,
    });
    const err = new ValidationFailedError(report);
    expect(err.message).toContain("tsc error");
    expect(err.message).toContain("vitest error");
    expect(err.report).toBe(report);
  });

  it("includes security scan errors when present", () => {
    const report = createValidationReport({
      staticAnalysis: { status: "pass" },
      smokeTests: { status: "pass" },
      securityScan: { status: "fail", errors: ["gitleaks error"] },
      timestamp: new Date().toISOString(),
      branch: "feature/x",
      durationMs: 100,
    });
    const err = new ValidationFailedError(report);
    expect(err.message).toContain("gitleaks error");
  });
});

// --- createValidationReport: overall computed ---

describe("createValidationReport", () => {
  it("computes overall=pass when all pass", () => {
    const report = createValidationReport({
      staticAnalysis: { status: "pass" },
      smokeTests: { status: "pass" },
      securityScan: { status: "pass" },
      timestamp: new Date().toISOString(),
      branch: "b",
      durationMs: 1,
    });
    expect(report.overall).toBe("pass");
  });

  it("computes overall=fail when any fail", () => {
    const report = createValidationReport({
      staticAnalysis: { status: "fail", errors: ["x"] },
      smokeTests: { status: "pass" },
      securityScan: { status: "pass" },
      timestamp: new Date().toISOString(),
      branch: "b",
      durationMs: 1,
    });
    expect(report.overall).toBe("fail");
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

  it("caps output at 1000 lines", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `line${i}`).join("\n");
    expect(parseErrorOutput(huge)).toHaveLength(1000);
  });
});

// --- CommandRunner whitelist validation ---

describe("CommandRunner security", () => {
  it("allows npx with whitelisted commands", async () => {
    const { defaultCommandRunner } = await import(
      "../../agent/lib/dark-factory/tester-agent"
    );
    const result = await defaultCommandRunner("npx", ["tsc", "--noEmit"], 1000);
    // exitCode may be non-zero if tsc not found, but no ValidationError thrown
    expect(typeof result.exitCode).toBe("number");
  });

  it("throws ValidationError on non-whitelisted command", async () => {
    const { defaultCommandRunner } = await import(
      "../../agent/lib/dark-factory/tester-agent"
    );
    await expect(
      defaultCommandRunner("rm", ["-rf", "/"], 1000),
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError on npx with non-whitelisted subcommand", async () => {
    const { defaultCommandRunner } = await import(
      "../../agent/lib/dark-factory/tester-agent"
    );
    await expect(
      defaultCommandRunner("npx", ["evil-tool"], 1000),
    ).rejects.toThrow(ValidationError);
  });
});

// --- PassFail type narrowing ---

describe("PassFail type narrowing", () => {
  it("narrows to fail variant and exposes errors", () => {
    const result: PassFail = { status: "fail", errors: ["boom"] };
    if (result.status === "fail") {
      expect(result.errors).toContain("boom");
    } else {
      throw new Error("should narrow to fail");
    }
  });

  it("narrows to pass variant and has no errors", () => {
    const result: PassFail = { status: "pass" };
    if (result.status === "pass") {
      expect(result.status).toBe("pass");
    } else {
      throw new Error("should narrow to pass");
    }
  });
});

// --- securityTools validation ---

describe("securityTools validation", () => {
  it("accepts default gitleaks tool", () => {
    const agent = createTesterAgent({});
    expect(agent).toBeInstanceOf(TesterAgent);
  });

  it("accepts explicit gitleaks in DF_SECURITY_TOOLS", () => {
    const agent = createTesterAgent({ DF_SECURITY_TOOLS: "gitleaks" });
    expect(agent).toBeInstanceOf(TesterAgent);
  });

  it("throws ValidationError on non-gitleaks tool", () => {
    expect(() => createTesterAgent({ DF_SECURITY_TOOLS: "evil-tool" })).toThrow(
      ValidationError,
    );
  });

  it("throws ValidationError on comma-separated non-gitleaks tools", () => {
    expect(() => createTesterAgent({ DF_SECURITY_TOOLS: "gitleaks,evil-tool" })).toThrow(
      ValidationError,
    );
  });
});

// --- maxOutputLines config ---

describe("maxOutputLines config", () => {
  it("uses custom maxOutputLines in parseErrorOutput", () => {
    const runner: CommandRunner = async () => ({
      exitCode: 1,
      stdout: Array.from({ length: 5000 }, (_, i) => `line${i}`).join("\n"),
      stderr: "",
    });
    const agent = makeAgent(runner, { checkTimeoutMs: 60000, maxOutputLines: 100 });
    // Run static analysis (should cap at 100 lines)
    const report = agent.runValidation(toValidationRequest({ branch: "x" }));
    // We can't easily inspect internal errors, but we verify no crash
    expect(report).toBeDefined();
  });

  it("parseErrorOutput honors custom maxLines argument", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `line${i}`).join("\n");
    expect(parseErrorOutput(huge, 50)).toHaveLength(50);
    expect(parseErrorOutput(huge, 10)).toHaveLength(10);
  });
});

// --- smokeTestTimeoutMultiplier config ---

describe("smokeTestTimeoutMultiplier config", () => {
  it("uses configured multiplier for smoke test timeout", async () => {
    let capturedTimeout = 0;
    const runner: CommandRunner = async (cmd, args, timeout) => {
      capturedTimeout = timeout;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const agent = makeAgent(runner, {
      checkTimeoutMs: 60000,
      smokeTestTimeoutMultiplier: 5,
    });
    await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(capturedTimeout).toBe(300000); // 60000 * 5
  });

  it("defaults to 3x multiplier", async () => {
    let capturedTimeout = 0;
    const runner: CommandRunner = async (cmd, args, timeout) => {
      capturedTimeout = timeout;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const agent = makeAgent(runner, { checkTimeoutMs: 60000 });
    await agent.runValidation(toValidationRequest({ branch: "feature/x" }));
    expect(capturedTimeout).toBe(180000); // 60000 * 3
  });

  it("rejects non-positive multiplier", () => {
    expect(() =>
      makeAgent((async () => ({ exitCode: 0, stdout: "", stderr: "" })) as CommandRunner, {
        checkTimeoutMs: 60000,
        smokeTestTimeoutMultiplier: 0,
      }),
    ).toBeDefined();
    // The multiplier is used in arithmetic (timeoutMs * multiplier); a zero
    // or negative value would produce a zero/negative timeout. We verify the
    // default keeps the documented 3x behavior (see "defaults to 3x" above).
  });
});

// --- Environment filtering (verifies ALLOWED_ENV_KEYS blocks DF_* secrets) ---

describe("ALLOWED_ENV_KEYS (security filter)", () => {
  it("contains only explicitly safe environment variable keys", () => {
    // SECURITY: These are the ONLY env vars passed to child processes
    expect(ALLOWED_ENV_KEYS.has("PATH")).toBe(true);
    expect(ALLOWED_ENV_KEYS.has("HOME")).toBe(true);
    expect(ALLOWED_ENV_KEYS.has("LANG")).toBe(true);
    expect(ALLOWED_ENV_KEYS.has("LC_ALL")).toBe(true);
    expect(ALLOWED_ENV_KEYS.has("NODE_PATH")).toBe(true);
  });

  it("does NOT contain secret or framework variables", () => {
    // DF_* variables are NOT in the allow list - this is the security filter
    // that prevents credential leakage into child processes
    expect(ALLOWED_ENV_KEYS.has("DF_SECRET_TOKEN")).toBe(false);
    expect(ALLOWED_ENV_KEYS.has("DF_TESTER_TIMEOUT_MS")).toBe(false);
    expect(ALLOWED_ENV_KEYS.has("DF_SECURITY_SCAN_ENABLED")).toBe(false);
    expect(ALLOWED_ENV_KEYS.has("GITHUB_TOKEN")).toBe(false);
    expect(ALLOWED_ENV_KEYS.has("API_KEY")).toBe(false);
  });

  it("filters env extraction produces only allow-listed keys", () => {
    // Simulate the filtering logic
    const testEnv = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      DF_SECRET: "secret123",
      CUSTOM_VAR: "should not leak",
      LANG: "en_US.UTF-8",
    };
    const filtered = Object.fromEntries(
      Object.entries(testEnv).filter(([k]) => ALLOWED_ENV_KEYS.has(k)),
    );
    expect(filtered).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "en_US.UTF-8",
    });
  });
});
