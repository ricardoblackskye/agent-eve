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