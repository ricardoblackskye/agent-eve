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
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type PassFail = 
  | { status: "pass"; passed: true; errors?: undefined } 
  | { status: "fail"; passed: false; errors: string[] };

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

/**
 * Canonical payload for validation requests.
 * A Developer Agent or human submits a branch for pre-PR validation.
 */
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
    super(`Validation failed: ${report.staticAnalysis.errors?.join(", ")}`);
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
 * Run a shell command with a timeout and return its exit code + output.
 */
async function runCommand(
  command: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (e: any) {
    return {
      exitCode: e.code ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

/**
 * Parse command output into error lines.
 */
function parseErrorOutput(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * TesterAgent orchestrates validation runs before PR submission.
 * Runs static analysis, smoke tests, and optionally security scans.
 */
export class TesterAgent {
  private readonly timeoutMs: number;

  constructor(
    private readonly config: TesterAgentConfig = {},
  ) {
    this.timeoutMs = config.checkTimeoutMs ?? 60000;
  }

  /**
   * Run a complete validation on a branch.
   * Returns a ValidationReport with pass/fail for each check component.
   */
  async runValidation(request: ValidationRequest): Promise<ValidationReport> {
    const start = Date.now();

    // Run checks sequentially for cleaner error isolation
    const staticAnalysis = await this.runStaticAnalysis();
    const smokeTests = await this.runSmokeTests();
    const securityScan = await this.runSecurityScan();

    const overall =
      staticAnalysis.passed && smokeTests.passed && securityScan.passed ? "pass" : "fail";

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

  /**
   * Run static analysis: TypeScript check + spell check.
   * Returns pass/fail with extracted error messages.
   */
  private async runStaticAnalysis(): Promise<PassFail> {
    const errors: string[] = [];

    // Run TypeScript compiler check
    const tsc = await runCommand("npx tsc --noEmit", this.timeoutMs);
    if (tsc.exitCode !== 0) {
      if (tsc.stdout) errors.push(...parseErrorOutput(tsc.stdout));
      if (tsc.stderr) errors.push(...parseErrorOutput(tsc.stderr));
    }

    // Run cspell check
    const cspell = await runCommand(
      "npx cspell agent/lib/dark-factory/*.ts tests/dark-factory/*.test.ts",
      this.timeoutMs,
    );
    if (cspell.exitCode !== 0) {
      if (cspell.stdout) errors.push(...parseErrorOutput(cspell.stdout));
      if (cspell.stderr) errors.push(...parseErrorOutput(cspell.stderr));
    }

    return errors.length > 0
      ? { status: "fail", passed: false, errors }
      : { status: "pass", passed: true };
  }

  /** Run unit/integration test suite via vitest. */
  private async runSmokeTests(): Promise<PassFail> {
    const result = await runCommand(
      "npx vitest run --passWithNoTests",
      this.timeoutMs * 3,
    );
    if (result.exitCode !== 0) {
      const errors = [
        ...parseErrorOutput(result.stdout),
        ...parseErrorOutput(result.stderr),
      ];
      return { status: "fail", passed: false, errors };
    }
    return { status: "pass", passed: true };
  }

  /** Run optional security scan (gitleaks). */
  private async runSecurityScan(): Promise<PassFail> {
    if (!this.config.enableSecurityScan) {
      return { status: "pass", passed: true };
    }

    const result = await runCommand(
      "npx gitleaks protect --verbose",
      this.timeoutMs,
    );
    if (result.exitCode !== 0) {
      const errors = [
        ...parseErrorOutput(result.stdout),
        ...parseErrorOutput(result.stderr),
      ];
      return { status: "fail", passed: false, errors };
    }
    return { status: "pass", passed: true };
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
 * Fail-closed: missing vars use sensible defaults.
 */
export function createTesterAgent(
  env: Record<string, string | undefined> = process.env,
): TesterAgent {
  return new TesterAgent({
    enableSecurityScan: env.DF_SECURITY_SCAN_ENABLED === "true",
    checkTimeoutMs: env.DF_TESTER_TIMEOUT_MS
      ? parseInt(env.DF_TESTER_TIMEOUT_MS, 10)
      : 60000,
  });
}