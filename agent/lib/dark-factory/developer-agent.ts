/**
 * Dark Factory — Developer Agent (issues #131 / story #133).
 *
 * A sandboxed coding agent that accepts a task description, writes code in a
 * worker sandbox, modifies existing files guided by a skeletal map, writes unit
 * tests, and iterates the TDD cycle until tests pass.
 *
 * DESIGN DECISIONS:
 * - Fail-closed defaults: missing required fields throw InvalidTaskError
 * - Canonical payload pattern: TaskAssignment for seam boundaries
 * - Metrics emission: records iterations/fix-cycles via MetricsStore
 * - Tool confinement: only git_clone, read_file, write_code, run_tests allowed
 * - Circuit breaker integration: reads cost metrics, never bypasses them
 *
 * ACCEPTANCE CRITERIA COVERED:
 * - AC1: produces code + tests from a task description
 * - AC2: iterates until unit tests pass (bounded)
 * - AC3: file modifications follow skeletal map guidance
 * - AC4: only the four allowed tools are invoked
 * - AC5: stops when tests pass and reports completed task
 */

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { filterChildEnv } from "./child-env";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { MetricsStore, TaskStatus } from "./metrics";
import type { Capabilities } from "./skills";
import type { ExecutionPlan } from "./plan-validator";
import { resolvePolicyMaxSteps } from "./llm-policy";
import type { WorkerActivitySink } from "./circuit-breaker";

const execAsync = promisify(exec);

/** Thrown when a TaskAssignment fails validation. */
export class InvalidTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskError";
  }
}

/** Git-style repo owner/name pattern: owner/repo. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Task id pattern: alphanumeric, dash, underscore; no spaces or special chars. */
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** A skeletal map of relative file path -> stub/skeleton content. */
export type SkeletonMap = Record<string, string>;

/** Canonical task assignment payload passed across the Developer Agent seam. */
export interface TaskAssignment {
  taskId: string;
  description: string;
  repo: string;
  ref: string;
  skeletonMap: SkeletonMap;
}

/** Input shape accepted by toTaskAssignment (ref/skeletonMap optional). */
export interface TaskAssignmentInput {
  taskId: string;
  description: string;
  repo: string;
  ref?: string;
  skeletonMap?: SkeletonMap;
}

/**
 * Build a validated TaskAssignment from raw input.
 * Throws InvalidTaskError on any missing/invalid required field.
 */
export function toTaskAssignment(input: TaskAssignmentInput): TaskAssignment {
  const taskId = input.taskId?.trim() ?? "";
  if (taskId.length === 0) {
    throw new InvalidTaskError("taskId is required (non-empty).");
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new InvalidTaskError(
      `taskId '${taskId}' is invalid; expected [A-Za-z0-9_-] only.`,
    );
  }

  const description = input.description?.trim() ?? "";
  if (description.length === 0) {
    throw new InvalidTaskError("description is required (non-empty).");
  }

  const repo = input.repo?.trim() ?? "";
  if (repo.length === 0) {
    throw new InvalidTaskError("repo is required (non-empty).");
  }
  if (!REPO_PATTERN.test(repo)) {
    throw new InvalidTaskError(
      `repo '${repo}' is invalid; expected 'owner/name' shape.`,
    );
  }

  const ref = input.ref?.trim() || "main";
  const skeletonMap = input.skeletonMap ?? {};

  return { taskId, description, repo, ref, skeletonMap };
}

// --- Task 133.2: TDD coding loop ---

/** Context passed to the worker on each iteration. */
export interface LoopContext {
  /** 1-based iteration index (1 = first attempt). */
  iteration: number;
  /**
   * The PREVIOUS iteration's failure, when there was one (#373).
   *
   * Without it the loop re-invokes the worker with identical inputs and gets identical output, so a loop
   * called self-correcting can never correct: a real run wrote byte-identical files on three consecutive
   * iterations and tripped the breaker with `failed-selfcorrect-exceeded`.
   *
   * Absent on the first attempt, and absent when the previous iteration failed without producing output,
   * so nothing is invented for a worker that reports only a verdict.
   */
  previousFailure?: { iteration: number; output: string };
}

/** Result returned by the worker for one iteration. */
export interface WorkerResult {
  passed: boolean;
  output?: string;
  /**
   * True when the iteration's tests could not even start (e.g. the checkout is not provisioned), so the result is
   * unmeasured rather than a failure of the developer's work (#541). Absent means measured.
   */
  unmeasured?: boolean;
}

/** A single coding iteration step (e.g. write code + run tests in a sandbox). */
export type WorkerFn = (ctx: LoopContext) => Promise<WorkerResult>;

/** Outcome of the coding loop. */
export interface LoopResult {
  status: "success" | "failed";
  iterations: number;
  fixCycles: number;
}

/**
 * An iteration whose tests could not even start, so its result is unmeasured rather than a
 * failure of the developer's work (#541, #559). The loop classifies it; the caller decides what
 * to record, because the loop is pure and owns no store or reporter.
 */
export interface UnmeasuredIteration {
  /** 1-based iteration index, matching `LoopContext.iteration`. */
  iteration: number;
  /** The worker's own explanation, when it gave one. */
  output?: string;
}

/**
 * Called when an iteration is unmeasured. Optional, so existing callers are unaffected.
 * The tap is an addition: the loop's return value does not change because of it.
 */
export type UnmeasuredTap = (
  info: UnmeasuredIteration,
) => void | Promise<void>;

/** Options for runCodingLoop. */
export interface CodingLoopOptions {
  worker: WorkerFn;
  maxIterations: number;
  onUnmeasured?: UnmeasuredTap;
}

/**
 * Drive the fail→fix→pass TDD cycle.
 *
 * Calls `worker` once per iteration. A non-passing result counts as a fix cycle
 * and the loop retries. Stops on the first passing result, or once `maxIterations`
 * have been attempted (whichever comes first).
 *
 * The bound is inclusive and `attempt` is 1-based to match `LoopContext.iteration`,
 * so the worker is called exactly `maxIterations` times with indexes
 * 1..maxIterations — there is no off-by-one to reason about.
 */
export async function runCodingLoop(
  opts: CodingLoopOptions,
): Promise<LoopResult> {
  let iterations = 0;
  let passed = false;

  for (let attempt = 1; attempt <= opts.maxIterations; attempt++) {
    iterations = attempt;
    const result = await opts.worker({ iteration: attempt });
    passed = result.passed;
    // An unmeasured iteration is NOT a failure of the developer's work (#541, #559): its tests
    // never started, so it is a roadblock to surface rather than a result to fix. Hand it to the
    // caller's tap, which owns whatever store and reporter exist. The tap deliberately does not
    // change this loop's outcome - that would be a behaviour decision with its own blast radius.
    if (!passed && result.unmeasured === true) {
      await opts.onUnmeasured?.({
        iteration: attempt,
        ...(result.output !== undefined ? { output: result.output } : {}),
      });
    }
    if (passed) break;
  }

  // A "fix cycle" is nothing more than an iteration that did not pass, so derive
  // it from the terminal state instead of keeping a second mutable counter: the
  // two numbers can then never drift apart.
  const fixCycles = passed ? iterations - 1 : iterations;

  return { status: passed ? "success" : "failed", iterations, fixCycles };
}

/**
 * Map a coding-loop outcome onto the metrics `TaskStatus` vocabulary.
 *
 * The loop reports `"success" | "failed"`; `MetricsStore`/`TaskStatus` reports
 * `"success" | "failure"`. Those are different words on purpose, so translate at
 * the boundary rather than casting — a cast would silently accept a mismatch.
 */
export function toTaskStatus(status: LoopResult["status"]): TaskStatus {
  return status === "success" ? "success" : "failure";
}

// --- Task 133.3: Skeletal map application (AC3) ---

/** Thrown when a skeleton map entry would write outside the workspace. */
export class SkeletonMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkeletonMapError";
  }
}

/**
 * File extensions a skeleton map may create (fail-closed allowlist).
 *
 * A traversal check alone still lets a worker scaffold ANY file type into the
 * workspace — `.sh`, `.exe`, or an extensionless `.git/hooks/pre-commit`.
 * The set is deliberately NARROW: this is a TypeScript project, so a skeleton map
 * only needs source, config and doc files. Executable/markup types (.js, .mjs,
 * .cjs, .jsx, .html) and style preprocessors (.scss) are excluded to keep the
 * attack surface small — widen this list only when a task genuinely needs them.
 */
export const ALLOWED_SKELETON_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".json",
  ".md",
  ".css",
  ".yml",
  ".yaml",
  ".txt",
]);

/**
 * Reject path shapes that lexical containment maths cannot be trusted with.
 *
 * Node's `path` helpers are platform-specific: on POSIX a Windows drive-relative
 * ("C:foo") or UNC ("\\\\server\\share\\foo") string is just a normal-looking
 * relative name, so `resolve`/`relative` containment says nothing useful about
 * it. Refuse those forms outright instead of trying to normalise them.
 *
 * Callers must run this BEFORE any `isAbsolute` check (#394): these guards use textual tests rather
 * than `path`, so they answer the same on every platform, and running them first is what keeps the
 * reported reason platform-independent.
 */
function assertSafeRelativePath(relPath: string): void {
  const reject = (why: string): never => {
    throw new SkeletonMapError(
      `Skeleton path '${relPath}' is rejected: ${why}.`,
    );
  };
  if (relPath.includes("\0")) reject("contains a null byte");
  if (/^[A-Za-z]:/.test(relPath)) reject("looks like a Windows drive path");
  if (relPath.startsWith("//") || relPath.startsWith("\\\\")) {
    reject("looks like a UNC path");
  }
}

/**
 * Write the skeleton map into `workspace`, creating parent directories.
 *
 * Fails closed (BEFORE any write) if an entry's path is absolute, uses a
 * drive/UNC form, contains a null byte, resolves outside `workspace`, escapes it
 * through a symlink, is itself an existing symlink, or has an extension outside
 * ALLOWED_SKELETON_EXTENSIONS.
 */
export async function applySkeletalMap(
  workspace: string,
  map: SkeletonMap,
  capabilities?: Capabilities,
): Promise<void> {
  // Capability set resolved from the skill surface (#157). Absent means the
  // fail-closed defaults, so every existing caller behaves exactly as before.
  const allowedExtensions =
    capabilities?.extensions ?? ALLOWED_SKELETON_EXTENSIONS;
  const root = resolve(workspace);
  await mkdir(root, { recursive: true });
  // Judge containment against the REAL directory: if the workspace itself is
  // reached through a symlink, `root`'s lexical form would not match its target.
  const realRoot = await realpath(root);

  for (const [relPath, content] of Object.entries(map)) {
    // #394: the SHAPE guards run FIRST so the stated reason is identical on every platform.
    // `path.isAbsolute` is platform-specific - on win32 a backslash-UNC or drive-absolute path IS
    // absolute, so checking absoluteness first skipped these guards entirely and reported the generic
    // reason instead of the precise one. Both checks still run, so nothing refused before is accepted
    // now; only which reason is reported changes.
    assertSafeRelativePath(relPath);
    if (isAbsolute(relPath)) {
      throw new SkeletonMapError(
        `Skeleton path '${relPath}' must be relative to the workspace.`,
      );
    }

    const target = resolve(root, relPath);
    const rel = relative(root, target);
    const inside =
      rel === "" ||
      (!isAbsolute(rel) && !rel.startsWith(".." + sep) && rel !== "..");
    if (!inside) {
      throw new SkeletonMapError(
        `Skeleton path '${relPath}' resolves outside the workspace; write refused.`,
      );
    }
    const ext = extname(relPath).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      throw new SkeletonMapError(
        `Skeleton path '${relPath}' has a disallowed extension '${
          ext || "(none)"
        }'; allowed: ${[...allowedExtensions].join(", ")}.`,
      );
    }

    await mkdir(dirname(target), { recursive: true });

    // Symlink defence: lexical containment cannot see a symlink placed INSIDE the
    // workspace that points outside it, so re-verify containment on the REAL
    // resolved parent now that it exists.
    const realParent = await realpath(dirname(target));
    const parentRel = relative(realRoot, realParent);
    const parentInside =
      parentRel === "" ||
      (!isAbsolute(parentRel) &&
        !parentRel.startsWith(".." + sep) &&
        parentRel !== "..");
    if (!parentInside) {
      throw new SkeletonMapError(
        `Skeleton path '${relPath}' escapes the workspace through a symlink; write refused.`,
      );
    }
    const existing = await lstat(target).catch(() => null);
    if (existing?.isSymbolicLink()) {
      throw new SkeletonMapError(
        `Skeleton path '${relPath}' is an existing symlink; write refused.`,
      );
    }

    await writeFile(target, content, "utf8");
  }
}

// --- Task 133.4: Tool confinement (AC4) ---

/** The only tools a Developer Agent worker may invoke (fail-closed allowlist). */
export const ALLOWED_TOOLS = new Set([
  "git_clone",
  "read_file",
  "write_code",
  "run_tests",
]);

/** Thrown when a worker attempts to invoke a tool outside ALLOWED_TOOLS. */
export class ToolNotAllowedError extends Error {
  constructor(tool: string) {
    super(
      `Tool '${tool}' is not permitted. Allowed: ${[...ALLOWED_TOOLS].join(", ")}.`,
    );
    this.name = "ToolNotAllowedError";
  }
}

/** Throw ToolNotAllowedError unless `tool` is in the allowlist. */
export function assertToolAllowed(
  tool: string,
  capabilities?: Capabilities,
): void {
  // Missing capabilities means the fail-closed defaults, so an existing caller
  // keeps exactly the confinement it had before this seam existed.
  const allowedTools = capabilities?.tools ?? ALLOWED_TOOLS;
  if (!allowedTools.has(tool)) {
    throw new ToolNotAllowedError(tool);
  }
}

// --- Task 133.5: Metrics integration (observability) ---

/**
 * Optional usage-ledger sink (#209). Deliberately a narrow structural contract
 * so the agent stays free of any store dependency — and best-effort by
 * definition: a usage failure must never fail the task.
 */
export interface WorkerUsageSink {
  record(measurement?: {
    taskType?: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    durationMs?: number;
  }): Promise<boolean>;
}

/** Options for createDeveloperAgent. */
export interface DeveloperAgentConfig {
  metrics: MetricsStore;
  maxIterations?: number;
  /** Usage-ledger sink; omitted or null means no usage events are recorded. */
  usage?: WorkerUsageSink | null;
}

/** Iteration record written to the metrics store on task completion. */
export interface IterationRecord {
  taskId: string;
  iterations: number;
  fixCycles: number;
  status: TaskStatus;
}

/** Default iteration cap when neither the policy nor an override is set. */
const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Default iteration cap, resolved from the LLM policy (#208) or
 * DF_MAX_ITERATIONS, which wins when set.
 * Fail-closed: a value that is not a positive integer throws rather than
 * silently running unbounded.
 */
function resolveMaxIterations(): number {
  // Resolve the policy FIRST when it is configured, so a malformed value fails
  // closed even when an explicit per-surface override is also present (#208).
  const policyMax = resolvePolicyMaxSteps(process.env, DEFAULT_MAX_ITERATIONS);
  const raw = process.env.DF_MAX_ITERATIONS?.trim();
  if (!raw) return policyMax;
  // Digits only. `Number()` alone would happily accept "1e3" (1000) and
  // "0x10" (16), which are not what "positive integer, digits" means.
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new InvalidTaskError(
      `DF_MAX_ITERATIONS must be a positive integer (digits only, received '${raw}').`,
    );
  }
  return Number(raw);
}

/**
 * Developer Agent seam with metrics emission.
 * Wraps a MetricsStore so iteration/fix-cycle outcomes are observable.
 */
export class DeveloperAgent {
  private readonly metrics: MetricsStore;
  private readonly usage: WorkerUsageSink | null;
  readonly maxIterations: number;

  constructor(config: DeveloperAgentConfig) {
    this.metrics = config.metrics;
    this.maxIterations = config.maxIterations ?? resolveMaxIterations();
    this.usage = config.usage ?? null;
  }

  /** Record a completed task's iteration outcome to the metrics store. */
  async recordIteration(rec: IterationRecord): Promise<void> {
    if (rec.status !== "success" && rec.status !== "failure") {
      throw new InvalidTaskError(
        `status must be 'success' or 'failure' (received ${JSON.stringify(rec.status)}).`,
      );
    }
    if (!Number.isInteger(rec.iterations) || rec.iterations < 0) {
      throw new InvalidTaskError("iterations must be a non-negative integer.");
    }
    if (!Number.isInteger(rec.fixCycles) || rec.fixCycles < 0) {
      throw new InvalidTaskError("fixCycles must be a non-negative integer.");
    }
    await this.metrics.record("developer", {
      iterations: rec.iterations,
      fixCycles: rec.fixCycles,
      status: rec.status,
    });

    // Usage recording is BEST-EFFORT (#209): telemetry must never fail the task,
    // so a sink failure is swallowed here rather than propagated. The sink is
    // absent unless an external usage driver is configured.
    if (this.usage) {
      try {
        await this.usage.record();
      } catch {
        // Ignored by design: see the WorkerUsageSink contract.
      }
    }
  }
}

/** Create a DeveloperAgent wired to the provided metrics store. */
export function createDeveloperAgent(
  config: DeveloperAgentConfig,
): DeveloperAgent {
  return new DeveloperAgent(config);
}

// --- Task 179: Multi-file workspace tools and bounded execution loop ---

export interface WorkspaceTools {
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  listFiles(pattern?: string): Promise<string[]>;
  runTests(cmd?: string): Promise<{ passed: boolean; output: string; ran: boolean }>;
}

export type CommandRunnerFn = (
  cmd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * The ONLY test commands either execution backend will run. Exported so the sandbox driver shares this
 * single list: two copies would drift, and drift here means a command becoming runnable on one backend.
 */
export const ALLOWED_TEST_COMMAND_PREFIXES: readonly string[] = [
  "npx vitest",
  "npm test",
  "npx tsc",
];

export const ALLOWED_WORKSPACE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".yml",
  ".yaml",
  ".txt",
  ".html",
  ".svg",
]);

/**
 * Creates sandboxed workspace tools confined to `workspaceDir`.
 * Fails closed on any path traversal attempt, validates file extensions,
 * and caches verified path resolutions to optimize filesystem operations.
 */
export function createWorkspaceTools(
  workspaceDir: string,
  commandRunner?: CommandRunnerFn,
  allowedExtensions?: ReadonlySet<string>,
): WorkspaceTools {
  const root = resolve(workspaceDir);
  const MAX_PATH_CACHE_SIZE = 1000;
  const resolvedPathCache = new Map<string, string>();

  const resolveContainedPath = async (relPath: string): Promise<string> => {
    const cached = resolvedPathCache.get(relPath);
    if (cached) {
      // Refresh LRU order
      resolvedPathCache.delete(relPath);
      resolvedPathCache.set(relPath, cached);
      return cached;
    }

    if (isAbsolute(relPath)) {
      throw new InvalidTaskError(
        `Path '${relPath}' must be relative to workspace; absolute path rejected.`,
      );
    }
    assertSafeRelativePath(relPath);
    const target = resolve(root, relPath);
    const rel = relative(root, target);
    const inside =
      rel === "" ||
      (!isAbsolute(rel) && !rel.startsWith(".." + sep) && rel !== "..");
    if (!inside) {
      throw new InvalidTaskError(
        `Path '${relPath}' resolves outside workspace; path traversal rejected.`,
      );
    }

    // Symlink defence: re-verify containment against real filesystem paths
    const realRoot = await realpath(root).catch(() => root);

    // If target exists, ensure it is not an escaping symlink
    const targetStat = await lstat(target).catch(() => null);
    if (targetStat?.isSymbolicLink()) {
      const realTarget = await realpath(target).catch(() => null);
      if (realTarget) {
        const symRel = relative(realRoot, realTarget);
        const symInside =
          symRel === "" ||
          (!isAbsolute(symRel) &&
            !symRel.startsWith(".." + sep) &&
            symRel !== "..");
        if (!symInside) {
          throw new InvalidTaskError(
            `Path '${relPath}' is a symlink resolving outside workspace; symlink traversal rejected.`,
          );
        }
      }
    }

    // Re-verify existing ancestor directories do not resolve outside workspace
    let ancestor = dirname(target);
    while (ancestor.length >= root.length) {
      const ancestorStat = await lstat(ancestor).catch(() => null);
      if (ancestorStat) {
        const realAncestor = await realpath(ancestor).catch(() => null);
        if (realAncestor) {
          const ancRel = relative(realRoot, realAncestor);
          const ancInside =
            ancRel === "" ||
            (!isAbsolute(ancRel) &&
              !ancRel.startsWith(".." + sep) &&
              ancRel !== "..");
          if (!ancInside) {
            throw new InvalidTaskError(
              `Path '${relPath}' escapes workspace via directory symlink; symlink traversal rejected.`,
            );
          }
        }
        break;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }

    if (resolvedPathCache.size >= MAX_PATH_CACHE_SIZE) {
      const oldestKey = resolvedPathCache.keys().next().value;
      if (oldestKey !== undefined) {
        resolvedPathCache.delete(oldestKey);
      }
    }
    resolvedPathCache.set(relPath, target);
    return target;
  };

  return {
    async readFile(relPath: string): Promise<string> {
      const target = await resolveContainedPath(relPath);
      return await readFile(target, "utf8");
    },

    async writeFile(relPath: string, content: string): Promise<void> {
      if (isAbsolute(relPath)) {
        throw new InvalidTaskError(
          `Path '${relPath}' must be relative to workspace; absolute path rejected.`,
        );
      }
      assertSafeRelativePath(relPath);
      const baseName = basename(relPath).toLowerCase();
      if (baseName === ".env" || baseName.startsWith(".env.")) {
        throw new InvalidTaskError(
          `File '${relPath}' is a protected configuration/secret file; write rejected.`,
        );
      }
      const ext = extname(relPath).toLowerCase();
      const permittedExtensions =
        allowedExtensions ?? ALLOWED_WORKSPACE_EXTENSIONS;
      if (!permittedExtensions.has(ext)) {
        throw new InvalidTaskError(
          `File '${relPath}' has disallowed extension '${
            ext || "(none)"
          }'. Permitted extensions: ${[...permittedExtensions].join(", ")}`,
        );
      }
      const target = await resolveContainedPath(relPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    },

    async listFiles(): Promise<string[]> {
      const results: string[] = [];
      const scan = async (dir: string) => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = resolve(dir, entry.name);
          const rel = relative(root, full).replace(/\\/g, "/");
          if (entry.isDirectory()) {
            if (entry.name !== "node_modules" && entry.name !== ".git") {
              await scan(full);
            }
          } else {
            results.push(rel);
          }
        }
      };
      await scan(root);
      return results;
    },

    async runTests(cmd?: string): Promise<{ passed: boolean; output: string; ran: boolean }> {
      const testCmd = (cmd ?? "npx vitest run").trim();

      // Security: Disallow all shell metacharacters, subshells, substitutions, and redirections
      if (/[;&|`$><()\\!#*?{}[\]^~"'\r\n]/.test(testCmd)) {
        throw new InvalidTaskError(
          `Command '${testCmd}' contains forbidden shell metacharacters or subshell syntax; command execution rejected.`,
        );
      }

      // Tokenize and parse command arguments
      const tokens = testCmd.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        throw new InvalidTaskError("Test command cannot be empty.");
      }

      // Validate each token contains only safe path, identifier, or flag characters
      const SAFE_TOKEN_PATTERN = /^[a-zA-Z0-9_.\/@:=-]+$/;
      for (const token of tokens) {
        if (!SAFE_TOKEN_PATTERN.test(token)) {
          throw new InvalidTaskError(
            `Command token '${token}' contains invalid characters; command execution rejected.`,
          );
        }
      }

      // Security: Allowlist permitted test commands
      const ALLOWED_TEST_PREFIXES = ALLOWED_TEST_COMMAND_PREFIXES;
      const isAllowed = ALLOWED_TEST_PREFIXES.some(
        (prefix) => testCmd === prefix || testCmd.startsWith(`${prefix} `),
      );
      if (!isAllowed) {
        throw new InvalidTaskError(
          `Command '${testCmd}' is not allowed. Only test commands starting with [${ALLOWED_TEST_PREFIXES.join(", ")}] are permitted.`,
        );
      }

      if (commandRunner) {
        const res = await commandRunner(testCmd);
        const output = res.stdout || res.stderr;
        return {
          passed: res.exitCode === 0,
          output,
          ran: classifyTestRun(output) === "ran",
        };
      }

      try {
        const { stdout, stderr } = await execAsync(testCmd, {
          cwd: root,
          maxBuffer: 10 * 1024 * 1024,
          // #275: `exec` INHERITS the parent environment when `env` is omitted, so the
          // child would otherwise see the push token, every DF_* knob and any database
          // URL. Hand it the same minimal allow-list the tester agent uses.
          env: filterChildEnv(process.env) as NodeJS.ProcessEnv,
        });
        return { passed: true, output: stdout || stderr, ran: classifyTestRun(stdout || stderr) === "ran" };
      } catch (err: any) {
        const output = err.stdout || err.stderr || err.message;
        return {
          passed: false,
          output,
          ran: classifyTestRun(output) === "ran",
        };
      }
    },
  };
}

/** Thrown when the circuit breaker has tripped: the coding loop halts fail-closed (#312). */
export class CircuitTrippedError extends Error {
  readonly code = "ERR_CIRCUIT_TRIPPED";
  constructor(message: string) {
    super(message);
    this.name = "CircuitTrippedError";
  }
}

/**
 * The circuit-breaker seam for the coding loop (#312).
 *
 * Deliberately a NARROW STRUCTURAL CONTRACT, in the same spirit as `WorkerUsageSink`: the
 * loop never imports the breaker module, and a breaker can never corrupt the loop's own
 * result. The breaker is a GUARD, not telemetry — once a PBI's budget is exceeded the loop
 * halts fail-closed at its next cooperative boundary instead of continuing to spend, so the
 * halt takes effect at the next ITERATION boundary, not mid-token.
 */
export interface CodingLoopBreaker {
  /** The unit of work this loop's activity is charged to (must satisfy PBI_ID_PATTERN). */
  pbiId: string;
  /** True once this PBI's budget is exhausted; consulted before each worker iteration. */
  isTripped(pbiId: string): boolean;
  /** Fed exactly one measurement per completed worker iteration. */
  recordActivity: WorkerActivitySink;
}

export interface MultiFileCodingLoopOptions {
  plan: ExecutionPlan;
  tools: WorkspaceTools;
  worker: (
    ctx: LoopContext & { plan: ExecutionPlan; tools: WorkspaceTools },
  ) => Promise<WorkerResult>;
  maxIterations: number;
  /** Called before each worker iteration at a cooperative control boundary. */
  checkpoint?: (iteration: number) => Promise<void>;
  /** Circuit-breaker seam (#312). Omitted or null keeps the loop's previous behaviour. */
  breaker?: CodingLoopBreaker | null;
}

/**
 * Fail-closed trip check at a cooperative boundary (#312). The breaker is a guard: once a
 * PBI's budget is exhausted the loop stops spending rather than finishing more iterations.
 */
function assertBreakerClosed(
  breaker: CodingLoopBreaker | null | undefined,
  iteration: number,
): void {
  if (!breaker || !breaker.isTripped(breaker.pbiId)) return;
  throw new CircuitTrippedError(
    `Circuit breaker tripped for ${breaker.pbiId} at iteration ${iteration}: ` +
      `the worker budget is exhausted. Halting fail-closed.`,
  );
}

/**
 * Drive the multi-file coding loop guided by the ExecutionPlan.
 */
/**
 * Classify whether a test command actually ran to a result, or failed to start at all (#541).
 *
 * A command that could not begin — a missing binary, a config that will not load, a package that is not installed
 * — is unmeasured: our environment's failure, never a verdict on the developer's work. This mirrors amm-scan's own
 * marker list for the same distinction. A test run that started and failed is NOT a startup failure and must stay
 * a failure, so the marker list is deliberately narrow; its negative cases are asserted beside the positive ones.
 */
export function classifyTestRun(output: string): "ran" | "did-not-start" {
  // These markers name a command that could not BEGIN (the live run died on `Cannot find package`), as distinct
  // from tests that started and failed. The list is intentionally narrow; a marker that matched ordinary test
  // output would silently make a real failure unmeasured.
  const DID_NOT_START_MARKERS = [
    "ERR_MODULE_NOT_FOUND",
    "Cannot find package",
    "Failed to load config",
    "failed to load config",
    "command not found",
    "is not recognized as",
  ];
  return DID_NOT_START_MARKERS.some((marker) => output.includes(marker)) ? "did-not-start" : "ran";
}

export async function runMultiFileCodingLoop(
  opts: MultiFileCodingLoopOptions,
): Promise<LoopResult> {
  let iterations = 0;
  let passed = false;
  // #373: what the last failed iteration said, offered to the next one. Discarding this is what made the
  // loop's self-correction impossible.
  let previousFailure: LoopContext["previousFailure"];

  for (let i = 0; i < opts.maxIterations; i++) {
    const iteration = i + 1;
    iterations = iteration;
    await opts.checkpoint?.(iteration);
    assertBreakerClosed(opts.breaker, iteration);
    const startedAt = Date.now();
    const res = await opts.worker({
      iteration,
      plan: opts.plan,
      tools: opts.tools,
      ...(previousFailure ? { previousFailure } : {}),
    });
    if (!res.passed && res.output) {
      previousFailure = { iteration, output: res.output };
    }
    // Record exactly one unit of activity per completed iteration. The breaker rounds
    // sub-minute work UP to a full minute, so an iteration cannot escape the budget.
    const breaker = opts.breaker;
    if (breaker) {
      // #541: an iteration whose tests could not even start is unmeasured — our environment's failure, not the
      // developer's — so it must not trip the breaker. A real test failure (ran, but not passed) still counts.
      if (!res.unmeasured) {
        breaker.recordActivity({
          pbiId: breaker.pbiId,
          durationMs: Date.now() - startedAt,
          status: res.passed ? "success" : "failure",
        });
      }
    }
    passed = res.passed;
    if (passed) break;
  }

  // Cooperative control check after the final worker call: a Stop (or Pause)
  // that arrives during the last model/test call must be honored BEFORE we
  // report success, so the runner never commits/pushes stopped work.
  await opts.checkpoint?.(iterations);
  // A trip raised by the FINAL iteration must halt too, rather than being reported as a
  // success the runner would then commit and push (#312).
  assertBreakerClosed(opts.breaker, iterations);

  const fixCycles = passed ? iterations - 1 : iterations;
  return { status: passed ? "success" : "failed", iterations, fixCycles };
}
