import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  buildLaunchDecision,
  defaultGitClone,
  renderProblems,
  runLocalRun,
  type LaunchSpawn,
  type NpmInstall,
  type RunnerSpawn,
  type SpawnResult,
} from "../../agent/lib/dark-factory/local-run";

/**
 * #404 R1 Task 4 - the launcher refuses BEFORE spawning, and reports every problem at once.
 *
 * The measured cost of not having this: five local runs, each ending in one refusal, each requiring a hand-change
 * to the environment. The launcher asserts all prerequisites up front; a single block says what is wrong and how to
 * fix it, and only then does it spawn the runner.
 */
const SECRET = "ghp_THIS-MUST-NEVER-APPEAR-3333333333";

const healthyProbes = {
  reachStore: async () => ({ ok: true as const }),
  reachSandbox: async () => ({ ok: true as const }),
};

const goodEnv = (over: Record<string, string> = {}): Record<string, string> => ({
  GITHUB_TOKEN: SECRET,
  OPENROUTER_API_KEY: "sk-plain-4444444444",
  DF_WORKER_ALLOWED_REPOS: "ricardoblackskye/WebFeedPOC",
  DF_RUN_HISTORY_DRIVER: "postgres",
  DF_CONTROL_DRIVER: "postgres",
  DF_RUN_HISTORY_DATABASE_URL: "postgres://postgres@localhost:5432/darkfactory?sslmode=disable",
  DF_CONTROL_DATABASE_URL: "postgres://postgres@localhost:5432/darkfactory?sslmode=disable",
  DF_SANDBOX_DRIVER: "opensandbox",
  DF_SANDBOX_ENDPOINT: "http://127.0.0.1:18082",
  DF_SANDBOX_IMAGE: "df-sandbox-webfeedpoc:4",
  ...over,
});

const baseInput = (over: Record<string, unknown> = {}) => ({
  repo: "ricardoblackskye/WebFeedPOC",
  issue: 169,
  workspaceRoot: "/tmp/df-workspaces",
  allowRemoteStore: true,
  probes: healthyProbes,
  env: goodEnv(),
  ...over,
});

const noopSpawn = async (): Promise<SpawnResult> => ({ exitCode: 0 });

describe("#404 R1 Task 4 - buildLaunchDecision", () => {
  it("refuses when the preflight reports a problem, and names it", async () => {
    const decision = await buildLaunchDecision(baseInput({ env: goodEnv({ GITHUB_TOKEN: "" }) }));

    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.problems.some((p) => p.code === "missing-github-token")).toBe(true);
    }
  });

  it("reports EVERY problem in one decision, not only the first", async () => {
    const decision = await buildLaunchDecision(
      baseInput({ env: goodEnv({ GITHUB_TOKEN: "", OPENROUTER_API_KEY: "" }) }),
    );

    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      const codes = decision.problems.map((p) => p.code);
      expect(codes).toContain("missing-github-token");
      expect(codes).toContain("missing-provider-key");
    }
  });

  it("launches when the preflight is clean, with the checkout as the working directory", async () => {
    const decision = await buildLaunchDecision(
      baseInput({ exists: () => false } as Record<string, unknown>),
    );

    expect(decision.kind).toBe("launch");
    if (decision.kind === "launch") {
      expect(decision.spawn.cwd.toLowerCase()).toContain("webfeedpoc-169");
      expect(decision.spawn.args.join(" ")).toContain("dark-factory-runner");
    }
  });

  it("passes the credentials through to the child (the child needs them) without them leaking into the decision", async () => {
    const decision = await buildLaunchDecision(baseInput());

    expect(decision.kind).toBe("launch");
    if (decision.kind === "launch") {
      // The token must reach the child (the child needs it); the guarantee is that the refusal TEXT never prints
      // it, which renderProblems asserts separately.
      expect(decision.spawn.env.GITHUB_TOKEN).toBe(SECRET);
    }
  });

  it("names a runnable entry: an existing ABSOLUTE script path, and the loader as a file:// URL", async () => {
    // The child's cwd is the checkout of the TARGET repository, which contains neither `tsx` nor `scripts/`.
    // Two distinct contracts, learned from two live failures:
    //   - the ENTRY SCRIPT must be a plain absolute path; passing a file:// URL there is resolved against the
    //     child's cwd (ERR_MODULE_NOT_FOUND);
    //   - the `--import` LOADER must be a file:// URL; a Windows path is rejected as ERR_UNSUPPORTED_ESM_URL_SCHEME.
    const decision = await buildLaunchDecision(baseInput());

    expect(decision.kind).toBe("launch");
    if (decision.kind === "launch") {
      const { args, cmd } = decision.spawn;
      expect(isAbsolute(cmd)).toBe(true);

      const runnerArg = args.find((a) => a.toLowerCase().includes("dark-factory-runner.ts"));
      expect(runnerArg).toBeDefined();
      expect(isAbsolute(runnerArg as string)).toBe(true);
      expect(existsSync(runnerArg as string)).toBe(true);

      const loader = args[args.indexOf("--import") + 1];
      expect(loader).toBeDefined();
      expect((loader as string).startsWith("file://")).toBe(true);
      expect(existsSync(fileURLToPath(loader as string))).toBe(true);
    }
  });
});

describe("#404 R1 Task 4 - renderProblems", () => {
  it("renders every problem with its variable and fix, and never a secret value", async () => {
    const decision = await buildLaunchDecision(baseInput({ env: goodEnv({ GITHUB_TOKEN: "", DF_RUN_HISTORY_DATABASE_URL: "" }) }));

    expect(decision.kind).toBe("refuse");
    const rendered = renderProblems({ ok: false, problems: decision.kind === "refuse" ? decision.problems : [] });

    expect(rendered).toContain("GITHUB_TOKEN");
    expect(rendered).toContain("postgres");
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain("x-access-token");
  });
});

describe("#404 R1 Task 4 - runLocalRun refuses before spawning", () => {
  it("does NOT spawn when the preflight fails", async () => {
    const spawned: LaunchSpawn[] = [];
    const spawnRunner: RunnerSpawn = async (o) => {
      spawned.push(o);
      return { exitCode: 0 };
    };

    const code = await runLocalRun(baseInput({ env: goodEnv({ GITHUB_TOKEN: "" }), spawnRunner, gitClone: async () => 0 }) as never);

    expect(spawned).toHaveLength(0);
    expect(code).toBe(1);
  });

  it("spawns with the checkout as cwd when the preflight is clean, and returns the child exit code", async () => {
    const spawned: LaunchSpawn[] = [];
    const spawnRunner: RunnerSpawn = async (o) => {
      spawned.push(o);
      return { exitCode: 0 };
    };

    const code = await runLocalRun(baseInput({ spawnRunner, gitClone: async () => 0 }) as never);

    expect(spawned).toHaveLength(1);
    expect(spawned[0].cwd.toLowerCase()).toContain("webfeedpoc-169");
    expect(code).toBe(0);
  });

  it("propagates a non-zero child exit without mutating the refusal contract", async () => {
    const spawnRunner: RunnerSpawn = async () => ({ exitCode: 7 });

    const code = await runLocalRun(baseInput({ spawnRunner, gitClone: async () => 0 }) as never);

    expect(code).toBe(7);
  });
});

/**
 * #501 - a first local run must not fail with `spawn git ENOENT`.
 *
 * The launcher clones with `cwd = dirname(checkout.path)`, which IS the workspace root, and nothing ever
 * created it. Node reports a MISSING CWD as ENOENT too, so a clean checkout failed with an error naming
 * `git` - which sent three attempts down PATH dead ends before the real cause was found.
 *
 * This drives the REAL clone rather than the injected seam: the seam would prove nothing about the spawn.
 */
describe("#501 the real clone prepares its workspace root", () => {
  it("does not reject with spawn ENOENT when the workspace root does not exist yet", async () => {
    const parent = mkdtempSync(join(tmpdir(), "df-501-clone-"));
    const checkoutPath = join(parent, "df-workspaces", "webfeedpoc-169");

    try {
      // `["clone"]` with no repository: git exits non-zero immediately by itself. That is the point -
      // a non-zero exit PROVES git ran, which a failed spawn could never do. It also needs no network.
      const code = await defaultGitClone(
        { path: checkoutPath, mustClone: true, cloneArgs: ["clone"], summary: "" } as never,
        {},
      );

      expect(existsSync(dirname(checkoutPath))).toBe(true);
      expect(code).not.toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("#539 - the launcher drives a resume", () => {
  const parked = {
    ...healthyProbes,
    activeClaim: async () => ({ ok: true, holder: { runId: "122ff27b-e044-489a-851f-593b7404ab70", status: "blocked" } }),
  };
  const none = { ...healthyProbes, activeClaim: async () => ({ ok: true }) };

  it("forwards --resume to the runner when asked, and NOT otherwise", async () => {
    const withFlag = await buildLaunchDecision(baseInput({ resume: true, probes: parked }));
    expect(withFlag.kind).toBe("launch");
    if (withFlag.kind === "launch") expect(withFlag.spawn.args).toContain("--resume");

    const without = await buildLaunchDecision(baseInput({ probes: parked }));
    expect(without.kind).toBe("refuse"); // a parked claim refuses a FRESH run
  });

  it("LAUNCHES a resume that continues a parked claim — the whole point of #539", async () => {
    const decision = await buildLaunchDecision(baseInput({ resume: true, probes: parked }));

    expect(decision.kind).toBe("launch");
    if (decision.kind === "launch") {
      expect(decision.spawn.args).toContain("--resume");
      expect(decision.spawn.args.join(" ")).toContain("--issue 169");
    }
  });

  it("REFUSES a resume with nothing to continue, in the same one block the launcher already gives", async () => {
    const decision = await buildLaunchDecision(baseInput({ resume: true, probes: none }));

    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") {
      expect(decision.problems.map((p) => p.code)).toContain("claim-not-held");
      expect(decision.problems[0]?.fix).toContain("without --resume");
    }
  });
});
describe("#541 - a fresh Node checkout is provisioned before the runner runs", () => {
  const lockfileExists = (p: string) => p.includes("package-lock.json");
  const workspaceExists = (p: string) => p.includes("df-workspaces/webfeedpoc-169");

  it("runs npm ci in a freshly cloned Node checkout before the runner", async () => {
    const installed: string[][] = [];
    const npmInstall: NpmInstall = async (plan) => {
      installed.push(plan.installArgs);
      return 0;
    };
    const spawnRunner: RunnerSpawn = async () => ({ exitCode: 0 });

    const code = await runLocalRun(
      baseInput({ exists: lockfileExists, spawnRunner, gitClone: async () => 0, npmInstall }) as never,
    );

    expect(installed).toEqual([["ci"]]);
    expect(code).toBe(0);
  });

  it("does NOT provision a reused checkout", async () => {
    const installed: string[][] = [];
    const npmInstall: NpmInstall = async (plan) => {
      installed.push(plan.installArgs);
      return 0;
    };
    const spawnRunner: RunnerSpawn = async () => ({ exitCode: 0 });

    const code = await runLocalRun(
      baseInput({ exists: workspaceExists, spawnRunner, gitClone: async () => 0, npmInstall }) as never,
    );

    expect(installed).toEqual([]);
    expect(code).toBe(0);
  });

  it("reports a failed install loudly but STILL runs the runner", async () => {
    const spawned: LaunchSpawn[] = [];
    const spawnRunner: RunnerSpawn = async (o) => {
      spawned.push(o);
      return { exitCode: 0 };
    };
    const npmInstall: NpmInstall = async () => 42;

    const code = await runLocalRun(
      baseInput({ exists: lockfileExists, spawnRunner, gitClone: async () => 0, npmInstall }) as never,
    );

    expect(spawned).toHaveLength(1);
    expect(code).toBe(0);
  });
});
