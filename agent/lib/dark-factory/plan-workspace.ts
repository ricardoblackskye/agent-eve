/**
 * The PLAN WORKSPACE gate (#405).
 *
 * Planning must read a checkout of the TARGET repository. The Architect used to infer its root from
 * `process.cwd()`, so a run launched from anywhere else planned against that directory instead - the
 * refusal in the #169 probe was correct behavior and the wrong input.
 */

export interface PlanWorkspaceInput {
  /** The target repository, as `owner/repo`. */
  targetRepo: string;
  /** The directory the runner was started in. */
  cwd: string;
  /** An explicit choice (`--workspace` or `DF_PLAN_WORKSPACE`); still verified. */
  override?: string | undefined;
  /** `git remote get-url origin` for a directory, or null when it is not a checkout. Injected. */
  remoteOf: (dir: string) => string | null;
}

export type PlanWorkspaceSource = "override" | "cwd";

export type PlanWorkspaceResult =
  | { ok: true; path: string; source: PlanWorkspaceSource }
  | { ok: false; problems: string[] };

export function resolvePlanWorkspace(input: PlanWorkspaceInput): PlanWorkspaceResult {
  throw new Error("not implemented");
}
