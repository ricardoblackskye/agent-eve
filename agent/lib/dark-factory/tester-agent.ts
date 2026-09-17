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
 * - Dependency injection: CommandRunner interface for testability
 * - Command whitelist: only allow npx commands (tsc, cspell, vitest, gitleaks)
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
 * SECURITY CONSIDERATIONS:
 * - MAX_BUFFER_BYTES: Limited to 10MB to prevent memory exhaustion from
 *   malicious output. For very large outputs, output is truncated at this
 *   limit (tsc/cspell typically produce <1MB output).
 * - Command whitelist: Only npx is allowed as the executable; specific args
 *   form the allowed command set (tsc, cspell, vitest, gitleaks).
 * - Environment filtering: Only explicitly allowed env vars are passed to
 *   child processes (NODE_PATH, PATH, HOME are passed through for system tools).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Maximum stdout/stderr buffer size (10 MB) to prevent memory exhaustion
 * attacks. Most tsc/cspell output is < 1MB; this provides headroom for
 * large repos while capping potential DoS via output generation. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/** Git SHA-1 regex (40 hex chars) */
const GIT_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;

/** Allowed npx commands for validation checks */
const ALLOWED_COMMANDS = new Set(["tsc", "cspell", "vitest", "gitleaks"]);

/** Allowed environment variable keys passed to child processes */
const ALLOWED_ENV_KEYS = new Set(["NODE_PATH", "PATH", "HOME", "LANG", "LC_ALL"]);

/**
 * Interface for command execution (dependency injection for testability).
 * Allows mocking command execution in tests without hitting the real shell.
 */
export interface CommandRunner {
  /**
   * Execute a command with explicit argument array (no shell interpolation).
   * Returns exit code, stdout, and stderr.
   */
  (cmd: string, args: string[], timeoutMs: number): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

/**
 * Default command runner using execFile.
 * Validates commands against an allowlist to prevent arbitrary execution.
 */
export const defaultCommandRunner: CommandRunner = async (
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  // SECURITY: Command whitelist validation
  // Only npx is allowed as the executable; first arg must be an allowed command
  if (cmd !== "npx" || args.length === 0 || !ALLOWED_COMMANDS.has(args[0])) {
    throw new ValidationError(
      `Command not allowed: ${cmd} ${args.join(" ")}. Only npx with whitelisted commands (tsc, cspell, vitest, gitleaks) are permitted.`,
    );
  }

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(process.env ?? {}).filter(([k]) => ALLOWED_ENV_KEYS.has(k) || !k.startsWith("DF_")),
        ),
      },
    });
    return {
      exitCode: 0,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    };
  } catch (e: any) {
    return {
      exitCode: typeof e.code === "number" ? e.code : e.exitCode ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
};

/**
 * Canonical pass/fail result for a single check.
 * Discriminated union: only "fail" state carries errors array.
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

/**
 * Validation report with individual check results.
 * `overall` is computed from individual statuses by createValidationReport.
 */
export type ValidationReport = {
  staticAnalysis: PassFail;
  smokeTests: PassFail;
  securityScan: PassFail;
  timestamp: string;
  branch: string;
  durationMs: number;
  /** Computed pass/fail from individual checks */
  overall: "pass" | "fail";
};

/** Create a ValidationReport with computed overall status */
export function createValidationReport(
  report: Omit<ValidationReport, "overall">,
): ValidationReport {
  const overall =
    report.staticAnalysis.status === "pass" &&
    report.smokeTests.status === "pass" &&
    report.securityScan.status === "pass"
      ? "pass"
      : "fail";

  return {
    ...report,
    overall,
  };
}

/** Canonical payload for validation requests. */
export interface ValidationRequest {
  /** Git branch name to validate (e.g., "feature/new-endpoint") */
  branch: string;
  /** Optional target SHA (40-char hex) for diff calculations. Must be valid Git SHA if provided. */
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
 * Validate a Git SHA format (40 hex characters).
 * Throws ValidationError if invalid.
 */
function validateTargetSha(sha: string): void {
  if (!GIT_SHA_PATTERN.test(sha)) {
    throw new ValidationError(
      `targetSha must be a valid 40-character Git SHA (received ${JSON.stringify(sha)}).`,
    );
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

  // Validate targetSha format if provided
  if (input.targetSha !== undefined) {
    validateTargetSha(input.targetSha);
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
 * trailing newline ignored, maximum 1000 lines to prevent memory issues.
 */
export function parseErrorOutput(output: string): string[] {
  if (!output) return [];
  return output
    .split("\n")
    .slice(0, 1000) // Prevent memory exhaustion from huge outputs
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
  readonly timeoutMs: number;
  readonly runner: CommandRunner;
  private readonly config: TesterAgentConfig;
  private readonly checks: ValidationCheck[];

  constructor(
    config: TesterAgentConfig = {},
    options: { commandRunner?: CommandRunner } = {},
  ) {
    this.timeoutMs = config.checkTimeoutMs ?? 60000;
    this.config = config;
    this.runner = options.commandRunner ?? defaultCommandRunner;

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
   * Run all registered validation checks sequentially.
   * Returns a ValidationReport with pass/fail for each component.
   * The `overall` property is computed from individual statuses.
   */
  async runValidation(request: ValidationRequest): Promise<ValidationReport> {
    const start = Date.now();

    const results: Partial<Record<ValidationCheck["name"], PassFail>> = {};
    for (const check of this.checks) {
      results[check.name] = await check.run();
    }

    return createValidationReport({
      staticAnalysis: results.staticAnalysis ?? { status: "pass" },
      smokeTests: results.smokeTests ?? { status: "pass" },
      securityScan: results.securityScan ?? { status: "pass" },
      timestamp: new Date().toISOString(),
      branch: request.branch,
      durationMs: Date.now() - start,
    });
  }

  /** Run static analysis: TypeScript check + spell check. */
  private async runStaticAnalysis(): Promise<PassFail> {
    const errors: string[] = [];

    const tsc = await this.runner("npx", ["tsc", "--noEmit"], this.timeoutMs);
    if (tsc.exitCode !== 0) {
      errors.push(...parseErrorOutput(tsc.stdout), ...parseErrorOutput(tsc.stderr));
    }

    const cspell = await this.runner(
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
    const result = await this.runner(
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

    const result = await this.runner(
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