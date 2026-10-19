import { describe, expect, it, vi } from "vitest";
import {
  buildLaunchDecision,
  renderProblems,
  runLocalRun,
  type LaunchSpawn,
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
      expect(decision.spawn.env.GITHUB_TOKEN).toBe(SECRET);
      expect(JSON.stringify(decision)).not.toContain(SECRET);
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

    const code = await runLocalRun(baseInput({ env: goodEnv({ GITHUB_TOKEN: "" }), spawnRunner }) as never);

    expect(spawned).toHaveLength(0);
    expect(code).toBe(1);
  });

  it("spawns with the checkout as cwd when the preflight is clean, and returns the child exit code", async () => {
    const spawned: LaunchSpawn[] = [];
    const spawnRunner: RunnerSpawn = async (o) => {
      spawned.push(o);
      return { exitCode: 0 };
    };

    const code = await runLocalRun(baseInput({ spawnRunner }) as never);

    expect(spawned).toHaveLength(1);
    expect(spawned[0].cwd.toLowerCase()).toContain("webfeedpoc-169");
    expect(code).toBe(0);
  });

  it("propagates a non-zero child exit without mutating the refusal contract", async () => {
    const spawnRunner: RunnerSpawn = async () => ({ exitCode: 7 });

    const code = await runLocalRun(baseInput({ spawnRunner }) as never);

    expect(code).toBe(7);
  });
});
