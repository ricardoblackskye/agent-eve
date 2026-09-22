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

import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import {
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
}

/** Result returned by the worker for one iteration. */
export interface WorkerResult {
  passed: boolean;
  output?: string;
}

/** A single coding iteration step (e.g. write code + run tests in a sandbox). */
export type WorkerFn = (ctx: LoopContext) => Promise<WorkerResult>;

/** Outcome of the coding loop. */
export interface LoopResult {
  status: "success" | "failed";
  iterations: number;
  fixCycles: number;
}

/** Options for runCodingLoop. */
export interface CodingLoopOptions {
  worker: WorkerFn;
  maxIterations: number;
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
    passed = (await opts.worker({ iteration: attempt })).passed;
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
    if (isAbsolute(relPath)) {
      throw new SkeletonMapError(
        `Skeleton path '${relPath}' must be relative to the workspace.`,
      );
    }
    assertSafeRelativePath(relPath);

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

/** Options for createDeveloperAgent. */
export interface DeveloperAgentConfig {
  metrics: MetricsStore;
  maxIterations?: number;
}

/** Iteration record written to the metrics store on task completion. */
export interface IterationRecord {
  taskId: string;
  iterations: number;
  fixCycles: number;
  status: TaskStatus;
}

/**
 * Default iteration cap, resolved from DF_MAX_ITERATIONS (default 10).
 * Fail-closed: a value that is not a positive integer throws rather than
 * silently running unbounded.
 */
function resolveMaxIterations(): number {
  const raw = process.env.DF_MAX_ITERATIONS?.trim();
  if (!raw) return 10;
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
  readonly maxIterations: number;

  constructor(config: DeveloperAgentConfig) {
    this.metrics = config.metrics;
    this.maxIterations = config.maxIterations ?? resolveMaxIterations();
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
  runTests(cmd?: string): Promise<{ passed: boolean; output: string }>;
}

export type CommandRunnerFn = (
  cmd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Creates sandboxed workspace tools confined to `workspaceDir`.
 * Fails closed on any path traversal attempt.
 */
export function createWorkspaceTools(
  workspaceDir: string,
  commandRunner?: CommandRunnerFn,
): WorkspaceTools {
  const root = resolve(workspaceDir);

  const resolveContainedPath = (relPath: string): string => {
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
    return target;
  };

  return {
    async readFile(relPath: string): Promise<string> {
      const target = resolveContainedPath(relPath);
      return await readFile(target, "utf8");
    },

    async writeFile(relPath: string, content: string): Promise<void> {
      const target = resolveContainedPath(relPath);
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

    async runTests(cmd?: string): Promise<{ passed: boolean; output: string }> {
      const testCmd = (cmd ?? "npx vitest run").trim();
      if (commandRunner) {
        const res = await commandRunner(testCmd);
        return {
          passed: res.exitCode === 0,
          output: res.stdout || res.stderr,
        };
      }

      // Security: Disallow shell metacharacters to prevent command injection
      if (/[;&|`$><\r\n]/.test(testCmd)) {
        throw new InvalidTaskError(
          `Command '${testCmd}' contains forbidden shell metacharacters; command execution rejected.`,
        );
      }

      // Security: Allowlist permitted test commands
      const ALLOWED_TEST_PREFIXES = ["npx vitest", "npm test", "npx tsc"];
      const isAllowed = ALLOWED_TEST_PREFIXES.some(
        (prefix) => testCmd === prefix || testCmd.startsWith(`${prefix} `),
      );
      if (!isAllowed) {
        throw new InvalidTaskError(
          `Command '${testCmd}' is not allowed. Only test commands starting with [${ALLOWED_TEST_PREFIXES.join(", ")}] are permitted.`,
        );
      }

      try {
        const { stdout, stderr } = await execAsync(testCmd, {
          cwd: root,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { passed: true, output: stdout || stderr };
      } catch (err: any) {
        return {
          passed: false,
          output: err.stdout || err.stderr || err.message,
        };
      }
    },
  };
}

export interface MultiFileCodingLoopOptions {
  plan: ExecutionPlan;
  tools: WorkspaceTools;
  worker: (
    ctx: LoopContext & { plan: ExecutionPlan; tools: WorkspaceTools },
  ) => Promise<WorkerResult>;
  maxIterations: number;
}

/**
 * Drive the multi-file coding loop guided by the ExecutionPlan.
 */
export async function runMultiFileCodingLoop(
  opts: MultiFileCodingLoopOptions,
): Promise<LoopResult> {
  let iterations = 0;
  let passed = false;

  for (let attempt = 1; attempt <= opts.maxIterations; attempt++) {
    iterations = attempt;
    const res = await opts.worker({
      iteration: attempt,
      plan: opts.plan,
      tools: opts.tools,
    });
    passed = res.passed;
    if (passed) break;
  }

  const fixCycles = passed ? iterations - 1 : iterations;
  return { status: passed ? "success" : "failed", iterations, fixCycles };
}

