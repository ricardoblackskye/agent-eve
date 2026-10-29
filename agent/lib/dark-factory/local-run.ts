import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn as nodeSpawn } from "node:child_process";
import { loadLocalEnv } from "../../../scripts/load-env";
import { preflightLocalRun, type PreflightResult } from "./local-run-preflight";
import { planCheckout, gitAuthEnv, type CheckoutPlan } from "./local-run-checkout";

export interface LaunchSpawn {
  cmd: string;
  args: string[];
  cwd: string;
  /** The child environment. It carries credentials (the child needs them) but is never printed as a whole. */
  env: Record<string, string>;
}

export type LaunchDecision =
  | { kind: "refuse"; problems: import("./local-run-preflight").PreflightProblem[] }
  | { kind: "launch"; checkout: CheckoutPlan; spawn: LaunchSpawn };

export interface LaunchInput {
  repo: string;
  issue: number;
  workspaceRoot: string;
  /** The environment the launcher itself received (already includes the loaded .env.local). */
  env: import("./local-run-preflight").PreflightEnv;
  probes?: import("./local-run-preflight").PreflightProbes;
  allowRemoteStore?: boolean;
  /** Continue the parked run holding this issue's claim (#539) instead of starting a fresh one. */
  resume?: boolean;
  /** Whether a path already exists — injected for tests; defaults to the filesystem. */
  exists?: (path: string) => boolean;
}

export interface SpawnResult {
  exitCode: number;
  signal?: string;
}

/** Injected so tests never spawn a real agent. */
export type RunnerSpawn = (opts: LaunchSpawn) => Promise<SpawnResult>;

/** The clone step, injected so tests never touch the network. */
export type GitClone = (plan: CheckoutPlan, authEnv: Record<string, string>) => Promise<number>;

/**
 * The provisioning step (#541): `npm ci` / `npm install` in a freshly cloned checkout, injected so tests never
 * run npm. The plan decides the arguments; this runs them there.
 */
export type NpmInstall = (plan: CheckoutPlan) => Promise<number>;

/** This module's own directory: `agent/lib/dark-factory`. */
const HERE = dirname(fileURLToPath(import.meta.url));
/** The repository root — so the runner's script path is absolute even when the child's cwd is a TARGET checkout. */
const REPO_ROOT = resolve(HERE, "..", "..", "..");
/**
 * The runner script, as a plain absolute PATH.
 *
 * Node resolves a `file://` URL given as the ENTRY argument against the child's cwd (ERR_MODULE_NOT_FOUND), whereas
 * a path is opened directly. The `--import` loader is the opposite case — see `resolveTsxLoader` below.
 */
const RUNNER_SCRIPT = join(REPO_ROOT, "scripts", "dark-factory-runner.ts");

/**
 * The tsx loader, resolved to an absolute file:// URL from THIS package.
 *
 * A bare `--import tsx` is resolved against the CHILD's cwd — the checkout of the target repository, which has no
 * tsx installed — and a Windows path (`C:\...`) is rejected by `--import` as ERR_UNSUPPORTED_ESM_URL_SCHEME, since
 * it is read as a URL whose scheme is `c:`. Both the loader and the runner script are therefore passed as file://
 * URLs. Falls back to the bare specifier only if resolution itself fails, so that failure is named at spawn time.
 */
function resolveTsxLoader(): string {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  } catch {
    return "tsx";
  }
}

const RUNNER_BIN = { cmd: process.execPath, args: ["--import", resolveTsxLoader(), RUNNER_SCRIPT] };

/**
 * The decision: refuse when the preflight is unhappy, otherwise plan the checkout and assemble the child process.
 * Pure except for the one `existsSync` it uses to decide whether to clone — and that predicate is the same one the
 * filesystem would answer, so the decision is still deterministic and testable through the planned path.
 */
export async function buildLaunchDecision(input: LaunchInput): Promise<LaunchDecision> {
  const result = await preflightLocalRun({
    env: input.env,
    repo: input.repo,
    issue: input.issue,
    probes: input.probes,
    allowRemoteStore: input.allowRemoteStore,
    ...(input.resume ? { resume: true } : {}),
  });

  if (!result.ok) {
    return { kind: "refuse", problems: result.problems };
  }

  const checkout = planCheckout({
    repo: input.repo,
    workspaceRoot: input.workspaceRoot,
    exists: input.exists ?? existsSync,
    issue: input.issue,
  });

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (value !== undefined) env[key] = value;
  }

  const spawn: LaunchSpawn = {
    cmd: RUNNER_BIN.cmd,
    args: [
      ...RUNNER_BIN.args,
      "--repo",
      input.repo,
      "--issue",
      String(input.issue),
      // #539: the runner already reads `process.argv.includes("--resume")`; the launcher had no path for it.
      ...(input.resume ? ["--resume"] : []),
    ],
    cwd: checkout.path,
    // The launcher loaded .env.local into its own process.env; the child inherits those plus the explicit env.
    env,
  };

  return { kind: "launch", checkout, spawn };
}

/** Render the refusal as one block: every problem, its variable, and the exact fix. */
export function renderProblems(result: PreflightResult): string {
  if (result.ok) return "";
  const lines = ["Dark Factory local run — prerequisites not met:", ""];
  result.problems.forEach((problem, i) => {
    lines.push(`  ${i + 1}. ${problem.subject}`);
    lines.push(`     ${problem.fix}`);
    lines.push("");
  });
  lines.push(
    "Fix every item above, then re-run. A park is expected: the run posts a plan and waits for approval (#378).",
  );
  return lines.join("\n");
}

/** The real clone: a single git invocation authenticated through the environment, with a clean URL. */
export const defaultGitClone: GitClone = (plan, authEnv) =>
  new Promise<number>((resolve, reject) => {
    // #501: create the clone's parent BEFORE spawning. `cwd` below IS the workspace root, and Node
    // reports a MISSING CWD as `spawn git ENOENT` - an error that names git and cost three local
    // attempts chasing PATH before the real cause was found. `recursive: true` is a no-op when the
    // root already exists, so this cannot fail a run that would otherwise have worked.
    mkdirSync(dirname(plan.path), { recursive: true });

    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...authEnv })) {
      if (value !== undefined) merged[key] = value;
    }
    const child = nodeSpawn("git", plan.cloneArgs, {
      cwd: dirname(plan.path),
      env: merged as unknown as NodeJS.ProcessEnv,
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

/**
 * The real provisioning step (#541): install the fresh checkout's dependencies with its own npm, in the checkout
 * itself. Running `npm` (not `npx`) here keeps the install inside the target; the coding loop's `npx vitest run`
 * then resolves the nearest `node_modules` and no longer dies before collecting a test.
 */
export const defaultNpmInstall: NpmInstall = (plan) =>
  new Promise<number>((resolve, reject) => {
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) merged[key] = value;
    }
    const child = nodeSpawn("npm", plan.installArgs, {
      cwd: plan.path,
      env: merged as unknown as NodeJS.ProcessEnv,
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });

/** The real run: inherit the launcher's stdio so the agent's own output is visible. */
export const defaultRunnerSpawn: RunnerSpawn = (opts) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = nodeSpawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env as unknown as NodeJS.ProcessEnv,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      resolve({ exitCode: code ?? (signal ? 1 : 0), signal: signal ?? undefined }),
    );
  });

/**
 * Run it: refuse before spawning, clone if needed, run the child, and translate a park into a clear line rather
 * than silence. The launcher never prints the child's environment.
 */
export async function runLocalRun(
  input: LaunchInput & { spawnRunner?: RunnerSpawn; gitClone?: GitClone; npmInstall?: NpmInstall },
): Promise<number> {
  const { spawnRunner, gitClone, npmInstall, ...rest } = input;
  const decision = await buildLaunchDecision(rest);

  if (decision.kind === "refuse") {
    // Stderr, so the block is not silently merged with the agent's own stdout when a run does start.
    process.stderr.write(renderProblems({ ok: false, problems: decision.problems }));
    process.stderr.write("\n");
    return 1;
  }

  if (decision.checkout.mustClone) {
    const code = await (gitClone ?? defaultGitClone)(
      decision.checkout,
      gitAuthEnv(rest.env.GITHUB_TOKEN ?? ""),
    );
    if (code !== 0) {
      process.stderr.write(`git clone failed (exit ${code})\n`);
      return code;
    }
  }

  // #541: a freshly cloned checkout has no node_modules, so provision it here, before the runner. A reused
  // checkout was already provisioned, and a non-Node target carries no installArgs at all. A failed install is
  // reported loudly but does NOT stop the run: the coding loop then reports its tests as unmeasured rather than as
  // a failure caused by our own environment.
  if (decision.checkout.installArgs.length > 0) {
    const installCode = await (npmInstall ?? defaultNpmInstall)(decision.checkout);
    if (installCode !== 0) {
      process.stderr.write(
        `npm ${decision.checkout.installArgs.join(" ")} failed (exit ${installCode}) — the coding loop will report its tests as unmeasured\n`,
      );
    }
  }

  const result = await (spawnRunner ?? defaultRunnerSpawn)(decision.spawn);
  if (result.exitCode === 0) {
    process.stdout.write(
      "\nDark Factory run finished. If it parked, the plan is on the issue awaiting approval (#378); re-run " +
        "once the plan is approved or the run is retired.\n",
    );
  }
  return result.exitCode;
}

/** Load the agent's .env.local into the launcher's environment so the child inherits it. */
export function loadLauncherEnv(dir?: string): void {
  loadLocalEnv(dir);
}
