import { resolveWorkerAllowedRepos } from "./credentials";

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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

/** The host of a connection string, or undefined when it cannot be parsed. Never returns credentials. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function isLocalStore(url: string): boolean {
  const host = hostOf(url);
  return host !== undefined && LOCAL_HOSTS.has(host);
}

const POSTGRES_HINT =
  "start one with: docker run -d --name df-cov-pg -p 5432:5432 " +
  "-e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=darkfactory postgres:16-alpine";

/** The store a run records itself in, and the one it writes control state to (#404 items 4-6). */
function storeProblems(env: PreflightEnv, problems: PreflightProblem[]): {
  historyUrl?: string;
  controlUrl?: string;
} {
  const historyDriver = (env.DF_RUN_HISTORY_DRIVER ?? "").trim().toLowerCase();
  const historyUrl = (env.DF_RUN_HISTORY_DATABASE_URL ?? "").trim();
  const historyPath = (env.DF_RUN_HISTORY_DB_PATH ?? "").trim();

  if (historyDriver === "postgres") {
    if (!historyUrl) {
      problems.push({
        code: "run-history-not-configured",
        subject: "DF_RUN_HISTORY_DATABASE_URL",
        fix: `DF_RUN_HISTORY_DRIVER=postgres needs a connection string; ${POSTGRES_HINT}`,
      });
    }
  } else if (historyDriver === "sqlite") {
    if (!historyPath) {
      problems.push({
        code: "run-history-not-configured",
        subject: "DF_RUN_HISTORY_DB_PATH",
        fix: "DF_RUN_HISTORY_DRIVER=sqlite needs DF_RUN_HISTORY_DB_PATH pointing at a writable file",
      });
    }
  } else if (historyDriver === "") {
    problems.push({
      code: "run-history-not-configured",
      subject: "DF_RUN_HISTORY_DRIVER",
      fix:
        "without a run-history store the run is not recorded and the runner refuses to change control state; " +
        "set DF_RUN_HISTORY_DRIVER=postgres with DF_RUN_HISTORY_DATABASE_URL",
    });
  }

  // The control store falls back to the run-history URL, exactly as control.ts does — mirrored here rather than
  // invented, so the preflight cannot disagree with the module that will actually build the store.
  const controlDriver = (env.DF_CONTROL_DRIVER ?? "").trim().toLowerCase();
  const controlUrl = (env.DF_CONTROL_DATABASE_URL ?? "").trim() || historyUrl;
  const controlPath = (env.DF_CONTROL_DB_PATH ?? "").trim();

  if (controlDriver === "postgres") {
    if (!controlUrl) {
      problems.push({
        code: "control-store-not-configured",
        subject: "DF_CONTROL_DATABASE_URL",
        fix: `DF_CONTROL_DRIVER=postgres needs DF_CONTROL_DATABASE_URL (or DF_RUN_HISTORY_DATABASE_URL); ${POSTGRES_HINT}`,
      });
    }
  } else if (controlDriver === "sqlite") {
    if (!controlPath) {
      problems.push({
        code: "control-store-not-configured",
        subject: "DF_CONTROL_DB_PATH",
        fix: "DF_CONTROL_DRIVER=sqlite needs DF_CONTROL_DB_PATH pointing at a writable file",
      });
    }
  } else if (controlDriver === "") {
    problems.push({
      code: "control-store-not-configured",
      subject: "DF_CONTROL_DRIVER",
      fix:
        "the runner refuses to change control state without a store; set DF_CONTROL_DRIVER=postgres with " +
        "DF_CONTROL_DATABASE_URL",
    });
  }

  return { historyUrl: historyUrl || undefined, controlUrl: controlUrl || undefined };
}

export async function preflightLocalRun(input: PreflightInput): Promise<PreflightResult> {
  const { env, repo, issue, probes = {}, allowRemoteStore = false } = input;
  const problems: PreflightProblem[] = [];

  // 1. Credentials, by NAME. The runner fails closed on both of these, so the launcher says so first.
  if ((env.GITHUB_TOKEN ?? "").trim() === "") {
    problems.push({
      code: "missing-github-token",
      subject: "GITHUB_TOKEN",
      fix: "provide a GitHub token with repo scope for the clone and the push (at runtime, never in .env.local)",
    });
  }
  if ((env.OPENROUTER_API_KEY ?? "").trim() === "") {
    problems.push({
      code: "missing-provider-key",
      subject: "OPENROUTER_API_KEY",
      fix:
        "provide the provider key at runtime - the runner refuses to start without it; pull it (for example " +
        "`vercel env pull` to a temp file), read it, and delete the file",
    });
  }

  // 2. The allow list, through the SAME parser the runner uses, so the two cannot drift. Unset means REFUSED
  // rather than permitted: fail closed, never open.
  let allowed: string[] = [];
  try {
    allowed = resolveWorkerAllowedRepos(env);
  } catch (error) {
    problems.push({
      code: "repo-not-allowed",
      subject: "DF_WORKER_ALLOWED_REPOS",
      fix: `the allow list could not be parsed (${error instanceof Error ? error.message : String(error)})`,
    });
  }
  if (allowed.length === 0 || !allowed.includes(repo.toLowerCase())) {
    if (!problems.some((p) => p.code === "repo-not-allowed")) {
      problems.push({
        code: "repo-not-allowed",
        subject: "DF_WORKER_ALLOWED_REPOS",
        fix:
          `${repo} must be listed in DF_WORKER_ALLOWED_REPOS (comma-separated owner/repo); an unset list ` +
          "refuses every target rather than permitting any",
      });
    }
  }

  // 3. The stores.
  const { historyUrl, controlUrl } = storeProblems(env, problems);

  // 4. A hosted store is refused locally unless an operator asks for it by name. Observed failure: the
  // certificate chain aborted a park, so a target that could not be justified could not even ask its question.
  const remote = [historyUrl, controlUrl].filter(
    (url): url is string => typeof url === "string" && !isLocalStore(url),
  );
  if (!allowRemoteStore && remote.length > 0) {
    const hosts = [...new Set(remote.map((url) => hostOf(url) ?? "unknown host"))].join(", ");
    problems.push({
      code: "remote-store-refused",
      subject: "DF_RUN_HISTORY_DATABASE_URL / DF_CONTROL_DATABASE_URL",
      fix:
        `a hosted store (${hosts}) carries a certificate a local run cannot verify - point at a local Postgres, ` +
        "or pass --allow-remote-store to accept it (ADR 0039 governs trust; never disable verification)",
    });
  }

  // 5. Reachability. Each probe reports "not reachable" as a prerequisite, and never hangs on a timeout of its own.
  if (probes.reachStore && historyUrl && !problems.some((p) => p.code === "run-history-not-configured")) {
    const reach = await probes.reachStore(historyUrl);
    if (!reach.ok) {
      problems.push({
        code: "store-unreachable",
        subject: "the run-history store",
        fix:
          `cannot reach the store at ${hostOf(historyUrl) ?? "the configured host"} ` +
          `(${reach.error ?? "no response"}); ${POSTGRES_HINT}`,
      });
    }
  }

  // 6. The sandbox seam — only when a sandbox driver actually needs it.
  const sandboxDriver = (env.DF_SANDBOX_DRIVER ?? "").trim().toLowerCase();
  const sandboxEndpoint = (env.DF_SANDBOX_ENDPOINT ?? "").trim();
  if (sandboxDriver === "opensandbox") {
    if (sandboxEndpoint === "") {
      problems.push({
        code: "sandbox-not-configured",
        subject: "DF_SANDBOX_ENDPOINT",
        fix: "DF_SANDBOX_DRIVER=opensandbox needs the endpoint of a port-forwarded opensandbox-server",
      });
    }
    if ((env.DF_SANDBOX_IMAGE ?? "").trim() === "") {
      problems.push({
        code: "sandbox-not-configured",
        subject: "DF_SANDBOX_IMAGE",
        fix:
          "name the project image, and load it INTO the cluster - images in the docker store are invisible to " +
          "the node's containerd",
      });
    }
    if (probes.reachSandbox && sandboxEndpoint !== "") {
      const reach = await probes.reachSandbox(sandboxEndpoint);
      if (!reach.ok) {
        problems.push({
          code: "sandbox-unreachable",
          subject: "DF_SANDBOX_ENDPOINT",
          fix:
            `no healthy sandbox at ${sandboxEndpoint} (${reach.error ?? "no response"}); check the port-forward ` +
            "to the opensandbox-server service and that no leftover sandboxes are holding the node",
        });
      }
    }
  }

  // 7. The claim, when a probe can read the ledger. A parked run holds its issue's claim until a human answers,
  // which is why a clean re-run can be refused by a run that finished hours ago.
  if (probes.activeClaim) {
    const claim = await probes.activeClaim(repo, issue);
    if (!claim.ok) {
      problems.push({
        code: "store-unreachable",
        subject: "the run-history store (claim check)",
        fix: `the ledger could not be read (${claim.error ?? "no response"}), so a held claim cannot be ruled out`,
      });
    } else if (claim.holder) {
      problems.push({
        code: "claim-held",
        subject: `${claim.holder.runId} holds ${repo}#${issue} (status '${claim.holder.status}')`,
        fix:
          "a run holds this issue's claim until it finishes or a human answers it; wait for it to finish, or " +
          `retire the claim if the process is gone: npm run df:retire-claim -- --repo ${repo} --issue ${issue}`,
      });
    }
  }

  return problems.length === 0
    ? {
        ok: true,
        problems: [],
        resolved: { storeUrl: historyUrl, sandboxEndpoint: sandboxEndpoint || undefined },
      }
    : { ok: false, problems };
}
