/**
 * #585 T4 (AC4) — the idempotent provisioning state file.
 *
 * WHY THIS EXISTS: a second `df:sandbox-up` against an unchanged workspace used to re-run
 * every stage — re-inspect every image, re-build the helm dependencies, re-run the rollout
 * wait — even though nothing had changed since the last successful run. On a cold Windows
 * box that is minutes of redundant work.
 *
 * The fix is a small JSON file that records, per stage, the inputs that produced the last
 * success. A re-run skips a stage only when those inputs still match reality. A changed
 * digest, context or port invalidates that stage AND its dependents, so a stale skip cannot
 * masquerade as a successful provision — the failure mode the plan calls out explicitly.
 *
 * No secrets are written: the recorded inputs are digests, context names and port numbers.
 *
 * The file lives at `.data/sandbox-provision-state.json` under the workspace, which is
 * gitignored alongside the rest of `.data/`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The stages that can be skipped on a resume. Teardown is never skipped. */
export const STAGES = ["vendor", "cluster", "deploy", "forward", "proof"] as const;
export type ProvisionStage = (typeof STAGES)[number];

/**
 * Which stages a change to one stage invalidates. A changed artifact digest invalidates the
 * deploy that consumed it; a changed cluster invalidates everything that talks to that
 * cluster. Kept as data so the cascade is reviewable rather than buried in conditionals.
 *
 * The cascade is applied TRANSITIVELY: invalidating a stage also invalidates its dependents'
 * dependents. Listing only direct dependents here would leave `forward` and `proof` recorded
 * as completed after a vendor change — a stale skip that would report a provision as proven
 * against bits that were never deployed. That is the exact failure this module exists to
 * prevent, so the transitive walk is the invariant, not an optimisation.
 */
export const DEPENDENTS: Record<ProvisionStage, ProvisionStage[]> = {
  vendor: ["deploy"],
  cluster: ["deploy", "forward", "proof"],
  deploy: ["forward", "proof"],
  forward: ["proof"],
  proof: [],
};

export interface StageState {
  status: "completed";
  /** The inputs that produced this success. Compared verbatim on the next run. */
  inputs: Record<string, unknown>;
  /** ISO timestamp, for operators reading the file. Not used in the skip decision. */
  timestamp: string;
}

export interface SandboxState {
  version: 1;
  stages: Partial<Record<ProvisionStage, StageState>>;
}

export const STATE_VERSION = 1;

/** The default location, relative to the workspace directory. */
export function defaultStateFile(workspaceDir: string): string {
  return join(workspaceDir, ".data", "sandbox-provision-state.json");
}

/**
 * Read the state file. A missing file is not an error — it means "never provisioned".
 * A malformed file is treated as absent rather than fatal: a corrupt cache of *skips* must
 * never stop a provision from running. It will be overwritten on the next success.
 */
export function loadState(stateFile: string): SandboxState {
  if (!existsSync(stateFile)) return { version: STATE_VERSION, stages: {} };
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as SandboxState;
    if (parsed?.version !== STATE_VERSION || typeof parsed.stages !== "object") {
      return { version: STATE_VERSION, stages: {} };
    }
    return parsed;
  } catch {
    return { version: STATE_VERSION, stages: {} };
  }
}

/** Write the state file atomically enough for a local CLI: mkdir, then write. */
export async function saveState(stateFile: string, state: SandboxState): Promise<void> {
  const dir = dirname(stateFile);
  if (dir && !existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Every stage invalidated by a change to `stage`, including indirect dependents. The walk is
 * depth-first with a visited set so the data table cannot introduce a cycle into an infinite
 * loop. Order is not significant — callers only delete the entries.
 */
export function invalidatedBy(stage: ProvisionStage): ProvisionStage[] {
  const affected: ProvisionStage[] = [];
  const seen = new Set<ProvisionStage>();
  const walk = (current: ProvisionStage): void => {
    for (const dependant of DEPENDENTS[current]) {
      if (seen.has(dependant)) continue;
      seen.add(dependant);
      affected.push(dependant);
      walk(dependant);
    }
  };
  walk(stage);
  return affected;
}

/** True when the stage completed before AND its recorded inputs equal the current ones. */
export function canSkipStage(
  state: SandboxState,
  stage: ProvisionStage,
  currentInputs: Record<string, unknown>,
): boolean {
  const saved = state.stages[stage];
  if (!saved || saved.status !== "completed") return false;
  return inputsMatch(saved.inputs, currentInputs);
}

/**
 * Record a stage success. Also clears any dependents whose recorded inputs were produced
 * from the previous version of this stage — they must re-run against the new reality.
 */
export function recordStageSuccess(
  state: SandboxState,
  stage: ProvisionStage,
  inputs: Record<string, unknown>,
  now: Date = new Date(),
): SandboxState {
  const next: SandboxState = {
    version: STATE_VERSION,
    stages: { ...state.stages },
  };
  next.stages[stage] = {
    status: "completed",
    inputs,
    timestamp: now.toISOString(),
  };
  for (const dependant of invalidatedBy(stage)) {
    delete next.stages[dependant];
  }
  return next;
}

/** Clear a stage and its dependents after a failure or an input mismatch. */
export function invalidateStage(
  state: SandboxState,
  stage: ProvisionStage,
): SandboxState {
  const next: SandboxState = {
    version: STATE_VERSION,
    stages: { ...state.stages },
  };
  delete next.stages[stage];
  for (const dependant of invalidatedBy(stage)) {
    delete next.stages[dependant];
  }
  return next;
}

/** A digest of a file's bytes, prefixed so the format is obvious in the JSON. */
export function digestOfFile(filePath: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
}

/**
 * Structural comparison of two input records. Order-independent and deep enough for the
 * flat records this module writes; a nested object would compare by JSON identity, which
 * is what we want for "did the recorded inputs change".
 */
function inputsMatch(
  saved: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  const savedKeys = Object.keys(saved).sort();
  const currentKeys = Object.keys(current).sort();
  if (savedKeys.length !== currentKeys.length) return false;
  for (let index = 0; index < savedKeys.length; index += 1) {
    const key = savedKeys[index];
    if (key !== currentKeys[index]) return false;
    if (JSON.stringify(saved[key]) !== JSON.stringify(current[key])) return false;
  }
  return true;
}

/** Exposed for tests: the parent directory of a state file, created on save. */
export function stateDir(stateFile: string): string {
  return dirname(stateFile);
}
