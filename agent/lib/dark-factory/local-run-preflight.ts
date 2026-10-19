/**
 * The local-run PREFLIGHT (#404 R1).
 *
 * Every prerequisite of a local Dark Factory run was discovered by hitting its refusal — five runs, one refusal
 * each. This module is the other half of that: it collects EVERY problem and returns them together, so a missing
 * prerequisite is one block of output rather than an afternoon of runs.
 *
 * It is a pure function of (env, target, probes): all I/O arrives through the probes, which is what makes the whole
 * chain testable without a database, a cluster or a network. Nothing here prints a secret value — problems name the
 * VARIABLE, never what is in it.
 */
export type PreflightProblemCode =
  | "missing-github-token"
  | "missing-provider-key"
  | "repo-not-allowed"
  | "run-history-not-configured"
  | "control-store-not-configured"
  | "remote-store-refused"
  | "store-unreachable"
  | "sandbox-not-configured"
  | "sandbox-unreachable"
  | "claim-held";

export interface PreflightProblem {
  /** Stable, so callers and tests never match on prose. */
  code: PreflightProblemCode;
  /** The variable, file or step that is missing. */
  subject: string;
  /** What to do about it, in one line. */
  fix: string;
}

/** The environment as the preflight sees it: values nothing, names everything. */
export type PreflightEnv = Record<string, string | undefined>;

export interface StoreProbe {
  ok: boolean;
  error?: string;
}

export interface ClaimProbe {
  ok: boolean;
  /** The run that currently holds the target's claim, when one does. */
  holder?: { runId: string; status: string };
  error?: string;
}

/**
 * All I/O the preflight performs, injected. A probe that is absent means the check is SKIPPED, never that it
 * passed — so the launcher can start with only the checks it can actually perform.
 */
export interface PreflightProbes {
  reachStore?: (url: string) => Promise<StoreProbe>;
  reachSandbox?: (endpoint: string) => Promise<StoreProbe>;
  activeClaim?: (repo: string, issue: number) => Promise<ClaimProbe>;
}

export interface PreflightInput {
  env: PreflightEnv;
  /** The target repository as `owner/repo`. */
  repo: string;
  issue: number;
  probes?: PreflightProbes;
  /** Set only by an explicit operator flag: a hosted store carries a certificate a local run cannot verify. */
  allowRemoteStore?: boolean;
}

export interface PreflightResult {
  ok: boolean;
  problems: PreflightProblem[];
  /** The values the launcher needs, never a secret. Absent when the run cannot proceed. */
  resolved?: {
    storeUrl?: string;
    sandboxEndpoint?: string;
  };
}

export async function preflightLocalRun(_input: PreflightInput): Promise<PreflightResult> {
  throw new Error("not implemented");
}
