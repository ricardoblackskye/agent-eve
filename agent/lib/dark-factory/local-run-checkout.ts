/**
 * The CHECKOUT PLANNER (#404 R1 Task 3).
 *
 * A local run's working directory must be a checkout of the TARGET repository, because discovery reads
 * `process.cwd()` (#405) — my own E2E scanned agent-eve while the story was about WebFeedPOC. This module decides
 * that directory and how to produce it.
 *
 * It exists as its own module for one security reason, learned by finding a real token on disk: a clone made with
 * a credential in its URL PERSISTS that credential in `.git/config`. So the URL here is always the clean public
 * one, and authentication arrives through `gitAuthEnv` for the single git invocation — never in argv (visible in a
 * process list) and never written to disk.
 *
 * The planner deliberately never sees a credential: the caller composes the two.
 */
export interface CheckoutPlanInput {
  /** The target repository as `owner/repo`. */
  repo: string;
  /** Where per-issue workspaces live. */
  workspaceRoot: string;
  /** Whether a path already exists — injected, so the planner needs no filesystem. */
  exists: (path: string) => boolean;
  issue: number;
}

export interface CheckoutPlan {
  /** The directory the child process must run in. */
  path: string;
  /** True when the plan expects the caller to clone; false when an existing checkout is reused. */
  mustClone: boolean;
  /** `git` arguments: the URL carries NO credential. Empty when no clone is needed. */
  cloneArgs: string[];
  /** A rendering safe to print: paths and a command, never a secret. */
  summary: string;
}

export function planCheckout(_input: CheckoutPlanInput): CheckoutPlan {
  throw new Error("not implemented");
}

/**
 * The environment for ONE git invocation, authenticating without putting the credential in the URL or in argv.
 *
 * `GIT_CONFIG_COUNT` is git's own mechanism for per-invocation config, so nothing is written to any config file
 * and nothing appears in a process list.
 */
export function gitAuthEnv(_token: string): Record<string, string> {
  throw new Error("not implemented");
}
