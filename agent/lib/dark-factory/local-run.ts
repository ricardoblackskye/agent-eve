/**
 * The LOCAL-RUN ORCHESTRATOR (#404 R1 Task 4).
 *
 * The piece that was missing: a single command that asserts every prerequisite (and reports ALL of them at once),
 * owns the two things a run silently depends on - a target checkout as the working directory, and a local
 * store - and refuses with one actionable block instead of an afternoon of refusals.
 *
 * This module holds the testable core. `scripts/dark-factory-local-run.ts` is the thin entry that parses argv and
 * calls `runLocalRun`. The decision (refuse vs launch) and the rendering are pure; the only side effect is the
 * spawn, which is injected so the decision can be asserted without running a real agent.
 */
import type {
  CheckoutPlan,
} from "./local-run-checkout";
import type {
  PreflightEnv,
  PreflightProblem,
  PreflightProbes,
  PreflightResult,
} from "./local-run-preflight";

export interface LaunchSpawn {
  cmd: string;
  args: string[];
  cwd: string;
  /** The child environment. It carries credentials (the child needs them) but is never printed as a whole. */
  env: Record<string, string>;
}

export type LaunchDecision =
  | { kind: "refuse"; problems: PreflightProblem[] }
  | { kind: "launch"; checkout: CheckoutPlan; spawn: LaunchSpawn };

export interface LaunchInput {
  repo: string;
  issue: number;
  workspaceRoot: string;
  /** The environment the launcher itself received. */
  env: PreflightEnv;
  probes?: PreflightProbes;
  allowRemoteStore?: boolean;
}

export interface SpawnResult {
  exitCode: number;
  signal?: string;
}

/** Injected so tests never spawn a real agent. */
export type RunnerSpawn = (opts: LaunchSpawn) => Promise<SpawnResult>;

export async function buildLaunchDecision(_input: LaunchInput): Promise<LaunchDecision> {
  throw new Error("not implemented");
}

/** Render the refusal as one block: every problem, its variable, and the exact fix. */
export function renderProblems(_result: PreflightResult): string {
  throw new Error("not implemented");
}

export async function runLocalRun(
  _input: LaunchInput & { spawnRunner?: RunnerSpawn; runnerBin?: string },
): Promise<number> {
  throw new Error("not implemented");
}
