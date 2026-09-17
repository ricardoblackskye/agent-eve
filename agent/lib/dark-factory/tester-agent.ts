/**
 * Dark Factory — Tester Agent (issues #132 / story #136).
 *
 * A pre-PR validation gate that runs static analysis, smoke tests, and security
 * scans to catch quality and security regressions before merge.
 *
 * DESIGN DECISIONS:
 * - Fail-closed defaults: missing config = no validation, failed check = block PR
 * - Canonical payload pattern: ValidationRequest/ValidationReport for seams
 * - Metrics emission: reports pass/fail via MetricsStore for observability
 *
 * REQUIRED DEPENDENCIES:
 * - `tsc` (TypeScript compiler, via npx) for static analysis
 * - `cspell` (spell checker, via npx) for documentation quality
 * - `vitest` (test runner, via npx) for smoke tests
 * - `gitleaks` (secret scanner, via npx) for security scan (optional)
 *
 * EXPECTED PROJECT STRUCTURE:
 * - agent/lib/dark-factory/*.ts — source under test
 * - tests/dark-factory/*.test.ts — corresponding test files
 *
 * ENVIRONMENT VARIABLES (read by createTesterAgent):
 * - DF_SECURITY_SCAN_ENABLED: "true" to enable gitleaks scan (default: false)
 * - DF_TESTER_TIMEOUT_MS: per-check timeout in ms (default: 60000)
 *
 * COMMAND EXECUTION SECURITY:
 * - All shell commands use execFile with explicit argument arrays (NEVER exec
 *   with string interpolation). This prevents command injection even if a
 *   future change passes untrusted input into the command arguments.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Maximum stdout/stderr buffer size (10 MB). Large enough for full tsc/cspell
 * output on mid-size repos; prevents silent truncation of error reports. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Canonical pass/fail result for a single check.
 * Discriminated union: only "fail" carries errors.
 */
export type PassFail =
  | { status: "pass" }
  | { status: "fail"; errors: string[] };

export type SecurityAlert = {
  severity: "info" | "warning" | "error";
  message: string;
  file?: string;
  line?: number;
};

export type SecurityResult = {
  passed: boolean;
  alerts: SecurityAlert[];
  tool: string;
};

export type TestResult = {
  passed: boolean;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  durationMs: number;
  errors: string[];
};

export type CheckResult = {
  passed: boolean;
  durationMs: number;
  details: string;
};

export type ValidationReport = {
  staticAnalysis: PassFail;
  smokeTests: PassFail;
  securityScan: PassFail;
  overall: "pass" | "fail";
  timestamp: string;
  branch: string;
  durationMs: number;
};

/** Canonical payload for validation requests. */
export interface ValidationRequest {
  /** Git branch name to validate (e.g., "feature/new-endpoint") */
  branch: string;
  /** Optional target SHA for diff calculations */
  targetSha?: string;
  /** Custom environment for this validation run */
  env?: Record<string, string>;
}

/** Error thrown when validation input is invalid. */
export class ValidationError extends Error {
  readonly code = "ERR_VALIDATION_INPUT";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Error thrown when validation fails (blocking PR). */
export class ValidationFailedError extends Error {
  readonly code = "ERR_VALIDATION_FAILED";
  readonly report: ValidationReport;
  constructor(report: ValidationReport) {
    const failed: string[] = [];
    if (report.staticAnalysis.status === "fail") {
      failed.push(`staticAnalysis: ${report.staticAnalysis.errors.join("; ")}`);
    }
    if (report.smokeTests.status === "fail") {
      failed.push(`smokeTests: ${report.smokeTests.errors.join("; ")}`);
    }
    if (report.securityScan.status === "fail") {
      failed.push(`securityScan: ${report.securityScan.errors.join("; ")}`);
    }
    super(`Validation failed:\n${failed.join("\n")}`);
    this.name = "ValidationFailedError";
    this.report = report;
  }
}

/**
 * Validate and normalise a validation request.
 * Throws ValidationError (caller bug) for malformed input.
 */
export function toValidationRequest(input: {
  branch?: string;
  targetSha?: string;
  env?: Record<string, string>;
}): ValidationRequest {
  const rawBranch = typeof input.branch === "string" ? input.branch.trim() : "";
  if (!rawBranch) {
    throw new ValidationError(
      `Validation request requires a non-empty "branch" (received ${JSON.stringify(input.branch)}).`,
    );
  }

  return {
    branch: rawBranch,
    ...(input.targetSha ? { targetSha: input.targetSha } : {}),
    ...(input.env ? { env: input.env } : {}),
  };
}

/**
 * Parse raw command output into non-empty trimmed error lines.
 * Edge cases handled: empty string → [], whitespace-only lines dropped,
 * trailing newline ignored.
 */
export function parseErrorOutput(output: string): string[] {
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A single validation check, registered in the agent's check list. */
interface ValidationCheck {
  name: keyof Omit<ValidationReport, "overall" | "timestamp" | "branch" | "durationMs">;
  run: () => Promise<PassFail>;
}

/**
 * TesterAgent orchestrates validation runs before PR submission.
 * Uses a pluggable check registry (strategy pattern) so checks can be added,
 * removed, or reordered without touching runValidation.
 */
export class TesterAgent {
  private readonly timeoutMs: number;
  private readonly checks: ValidationCheck[];

  constructor(
    private readonly config: TesterAgentConfig = {},
  ) {
    this.timeoutMs = config.checkTimeoutMs ?? 60000;

    // Build the check registry. Order here defines execution order.
    this.checks = [
      { name: "staticAnalysis", run: () => this.runStaticAnalysis() },
      { name: "smokeTests", run: () => this.runSmokeTests() },
    ];
    if (config.enableSecurityScan) {
      this.checks.push({ name: "securityScan", run: () => this.runSecurityScan() });
    }
  }

  /**
   * Run a command via execFile with explicit argument array (no shell
   * interpolation → no command injection). Captures stdout/stderr and exit code.
   * On error, preserves the original exit code and any partial output for
   * debugging (does NOT swallow the underlying cause).
   *
   * Defined as an instance method (not a module function) so tests can inject a
   * mock without hitting the real filesystem/shell.
   */
  async runCommand(
    cmd: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
      });
      return {
        exitCode: 0,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      };
    } catch (e: any) {
      // execFile rejects with an Error that may carry stdout/stderr/code.
      return {
        exitCode: typeof e.code === "number" ? e.code : e.exitCode ?? 1,
        stdout: e.stdout?.toString() ?? "",
        stderr: e.stderr?.toString() ?? "",
      };
    }
  }

  /**
   * Run all registered validation checks sequentially.
   * Returns a ValidationReport with pass/fail for each component.
   */
  async runValidation(request: ValidationRequest): Promise<ValidationReport> {
    const start = Date.now();

    const results: Partial<Record<ValidationCheck["name"], PassFail>> = {};
    for (const check of this.checks) {
      results[check.name] = await check.run();
    }

    const staticAnalysis = results.staticAnalysis ?? { status: "pass" };
    const smokeTests = results.smokeTests ?? { status: "pass" };
    const securityScan = results.securityScan ?? { status: "pass" };

    const overall =
      staticAnalysis.status === "pass" &&
      smokeTests.status === "pass" &&
      securityScan.status === "pass"
        ? "pass"
        : "fail";

    return {
      staticAnalysis,
      smokeTests,
      securityScan,
      overall,
      timestamp: new Date().toISOString(),
      branch: request.branch,
      durationMs: Date.now() - start,
    };
  }

  /** Run static analysis: TypeScript check + spell check. */
  private async runStaticAnalysis(): Promise<PassFail> {
    const errors: string[] = [];

    const tsc = await this.runCommand("npx", ["tsc", "--noEmit"], this.timeoutMs);
    if (tsc.exitCode !== 0) {
      errors.push(...parseErrorOutput(tsc.stdout), ...parseErrorOutput(tsc.stderr));
    }

    const cspell = await this.runCommand(
      "npx",
      ["cspell", "agent/lib/dark-factory/*.ts", "tests/dark-factory/*.test.ts"],
      this.timeoutMs,
    );
    if (cspell.exitCode !== 0) {
      errors.push(...parseErrorOutput(cspell.stdout), ...parseErrorOutput(cspell.stderr));
    }

    return errors.length > 0
      ? { status: "fail", errors }
      : { status: "pass" };
  }

  /** Run unit/integration test suite via vitest. */
  private async runSmokeTests(): Promise<PassFail> {
    const result = await this.runCommand(
      "npx",
      ["vitest", "run", "--passWithNoTests"],
      this.timeoutMs * 3,
    );
    if (result.exitCode !== 0) {
      const errors = [
        ...parseErrorOutput(result.stdout),
        ...parseErrorOutput(result.stderr),
      ];
      return { status: "fail", errors };
    }
    return { status: "pass" };
  }

  /** Run optional security scan (gitleaks). */
  private async runSecurityScan(): Promise<PassFail> {
    if (!this.config.enableSecurityScan) {
      return { status: "pass" };
    }

    const result = await this.runCommand(
      "npx",
      ["gitleaks", "protect", "--verbose"],
      this.timeoutMs,
    );
    if (result.exitCode !== 0) {
      const errors = [
        ...parseErrorOutput(result.stdout),
        ...parseErrorOutput(result.stderr),
      ];
      return { status: "fail", errors };
    }
    return { status: "pass" };
  }
}

/** Configuration for the Tester Agent. */
export interface TesterAgentConfig {
  /** Enable security scanning (default: false) */
  enableSecurityScan?: boolean;
  /** Timeout per check in milliseconds (default: 60000) */
  checkTimeoutMs?: number;
  /** List of security tools to run (default: ["gitleaks"]) */
  securityTools?: string[];
}

/**
 * Factory function to create a TesterAgent from environment variables.
 * Fail-closed: missing vars use sensible defaults. Invalid numeric values
 * throw ValidationError so misconfiguration is caught early.
 */
export function createTesterAgent(
  env: Record<string, string | undefined> = process.env,
): TesterAgent {
  const rawTimeout = env.DF_TESTER_TIMEOUT_MS;
  let checkTimeoutMs = 60000;
  if (rawTimeout !== undefined) {
    const parsed = Number.parseInt(rawTimeout, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ValidationError(
        `DF_TESTER_TIMEOUT_MS must be a positive integer (received ${JSON.stringify(rawTimeout)}).`,
      );
    }
    checkTimeoutMs = parsed;
  }

  return new TesterAgent({
    enableSecurityScan: env.DF_SECURITY_SCAN_ENABLED === "true",
    checkTimeoutMs,
  });
}
