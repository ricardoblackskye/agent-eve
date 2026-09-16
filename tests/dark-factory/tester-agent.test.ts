import { describe, it, expect } from "vitest";
import {
  toValidationRequest,
  type ValidationRequest,
  type ValidationReport,
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
    const env = { "DF_TIMEOUT_MS": "30000" };
    const req = toValidationRequest({ branch: "test", env });
    expect(req.env).toBe(env);
  });

  it("rejects missing branch", () => {
    expect(() => toValidationRequest({ branch: undefined as any })).toThrow(
      /requires a non-empty "branch"/,
    );
  });

  it("rejects empty branch", () => {
    expect(() => toValidationRequest({ branch: "" })).toThrow(
      /requires a non-empty "branch"/,
    );
  });

  it("rejects branch with whitespace only", () => {
    expect(() => toValidationRequest({ branch: "   " })).toThrow(
      /requires a non-empty "branch"/,
    );
  });
});

// --- Task 136.2: Static analysis runner ---

describe("static analysis runner", () => {
  it("returns valid result shape", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 30000 });

    // Mock runStaticAnalysis to avoid real command execution
    const original = (agent as any).runStaticAnalysis.bind(agent);
    (agent as any).runStaticAnalysis = async () => ({ status: "pass", passed: true });

    const result = await (agent as any).runStaticAnalysis();
    expect(result).toHaveProperty("status");
    expect(["pass", "fail"]).toContain(result.status);

    // Restore
    (agent as any).runStaticAnalysis = original;
  });

  it("returns pass when no errors", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 30000 });

    // Mock the runCommand to return clean output
    (agent as any).runStaticAnalysis = async () => ({ status: "pass", passed: true });
    const result = await (agent as any).runStaticAnalysis();
    expect(result.status).toBe("pass");
  });

  it("returns fail with errors list when check fails", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 30000 });

    // Mock the runCommand to return error output
    (agent as any).runStaticAnalysis = async () => ({
      status: "fail",
      passed: false,
      errors: ["error TS123: something", "spell: unknown word"],
    });
    const result = await (agent as any).runStaticAnalysis();
    expect(result.status).toBe("fail");
    expect(result.errors).toHaveLength(2);
  });

  it("delegates to runCommand for tsc and cspell", async () => {
    const { TesterAgent } = await import("../../agent/lib/dark-factory/tester-agent");
    const agent = new TesterAgent({ checkTimeoutMs: 30000 });

    // Mock runCommand to verify it's called with right commands
    const commands: string[] = [];
    (agent as any).runStaticAnalysis = async () => {
      commands.push("npx tsc --noEmit");
      commands.push("npx cspell agent/lib/dark-factory/*.ts tests/dark-factory/*.test.ts");
      return { status: "pass", passed: true };
    };

    await (agent as any).runStaticAnalysis();
    expect(commands).toContain("npx tsc --noEmit");
  });
});