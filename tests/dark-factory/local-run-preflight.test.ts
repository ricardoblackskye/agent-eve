import { describe, expect, it } from "vitest";
import {
  preflightLocalRun,
  type PreflightEnv,
  type PreflightProbes,
} from "../../agent/lib/dark-factory/local-run-preflight";

/**
 * #404 R1 Task 1 - the preflight reports EVERY problem at once, and never a secret.
 *
 * The measured cost of not having this: five local runs, each ending at ONE refusal — the provider key, the allow
 * list, the run-history driver, the control store, the certificate on a hosted store. Each was correct fail-closed
 * behaviour, and each cost a run to discover.
 */
const SECRET_KEY = "sk-or-v1-THIS-MUST-NEVER-APPEAR-0000000000";
const SECRET_TOKEN = "ghp_THIS-MUST-NEVER-APPEAR-1111111111";

/** A complete environment: every case below removes exactly what it is about. */
function completeEnv(over: PreflightEnv = {}): PreflightEnv {
  return {
    GITHUB_TOKEN: SECRET_TOKEN,
    OPENROUTER_API_KEY: SECRET_KEY,
    DF_WORKER_ALLOWED_REPOS: "ricardoblackskye/agent-eve,ricardoblackskye/WebFeedPOC",
    DF_RUN_HISTORY_DRIVER: "postgres",
    DF_RUN_HISTORY_DATABASE_URL: "postgres://postgres@localhost:5432/darkfactory?sslmode=disable",
    DF_CONTROL_DRIVER: "postgres",
    DF_CONTROL_DATABASE_URL: "postgres://postgres@localhost:5432/darkfactory?sslmode=disable",
    DF_SANDBOX_DRIVER: "opensandbox",
    DF_SANDBOX_ENDPOINT: "http://127.0.0.1:18082",
    DF_SANDBOX_PROTOCOL: "http",
    DF_SANDBOX_IMAGE: "df-sandbox-webfeedpoc:4",
    ...over,
  };
}

const HEALTHY: PreflightProbes = {
  reachStore: async () => ({ ok: true }),
  reachSandbox: async () => ({ ok: true }),
  activeClaim: async () => ({ ok: true }),
};

const TARGET = { repo: "ricardoblackskye/WebFeedPOC", issue: 169 };

const codes = (problems: { code: string }[]) => problems.map((p) => p.code);

describe("#404 R1 - the preflight reports every problem at once", () => {
  it("passes a complete environment and resolves what the launcher needs", async () => {
    const result = await preflightLocalRun({ env: completeEnv(), ...TARGET, probes: HEALTHY });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.resolved?.storeUrl).toContain("localhost");
    expect(result.resolved?.sandboxEndpoint).toBe("http://127.0.0.1:18082");
  });

  it("reports BOTH the missing token and the missing provider key, in one call", async () => {
    const result = await preflightLocalRun({
      env: completeEnv({ GITHUB_TOKEN: undefined, OPENROUTER_API_KEY: "" }),
      ...TARGET,
      probes: HEALTHY,
    });

    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual([
      "missing-github-token",
      "missing-provider-key",
    ]);
  });

  it("names the variable and gives the fix, rather than describing the symptom", async () => {
    const result = await preflightLocalRun({
      env: completeEnv({ GITHUB_TOKEN: undefined }),
      ...TARGET,
      probes: HEALTHY,
    });

    const [problem] = result.problems;
    expect(problem.subject).toBe("GITHUB_TOKEN");
    expect(problem.fix).toMatch(/token/i);
  });

  it("NEVER prints a secret value, even though it was given one", async () => {
    const result = await preflightLocalRun({
      env: completeEnv({ DF_WORKER_ALLOWED_REPOS: "someone-else/other-repo" }),
      ...TARGET,
      probes: HEALTHY,
    });

    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain(SECRET_KEY);
    expect(rendered).not.toContain(SECRET_TOKEN);
    expect(rendered).not.toContain("ghp_");
    expect(rendered).not.toContain("sk-or-");
  });

  it("refuses a target the allow-list does not contain, naming the variable", async () => {
    const result = await preflightLocalRun({
      env: completeEnv({ DF_WORKER_ALLOWED_REPOS: "ricardoblackskye/agent-eve" }),
      ...TARGET,
      probes: HEALTHY,
    });

    expect(codes(result.problems)).toContain("repo-not-allowed");
    const problem = result.problems.find((p) => p.code === "repo-not-allowed");
    expect(problem?.subject).toBe("DF_WORKER_ALLOWED_REPOS");
  });

  it("refuses when the allow-list is unset at all - fail closed, not open", async () => {
    const result = await preflightLocalRun({
      env: completeEnv({ DF_WORKER_ALLOWED_REPOS: "" }),
      ...TARGET,
      probes: HEALTHY,
    });

    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toContain("repo-not-allowed");
  });

  it("reports a postgres run-history driver with no URL", async () => {
    const result = await preflightLocalRun({
      env: completeEnv({ DF_RUN_HISTORY_DATABASE_URL: undefined }),
      ...TARGET,
      probes: HEALTHY,
    });

    expect(codes(result.problems)).toContain("run-history-not-configured");
  });

  it("reports a postgres control store with no URL", async () => {
    const result = await preflightLocalRun({
      env: completeEnv({ DF_CONTROL_DATABASE_URL: undefined, DF_RUN_HISTORY_DATABASE_URL: undefined }),
      ...TARGET,
      probes: HEALTHY,
    });

    expect(codes(result.problems)).toContain("control-store-not-configured");
  });

  it("refuses a HOSTED store by default, and allows it only when asked for by name", async () => {
    const hosted = completeEnv({
      DF_RUN_HISTORY_DATABASE_URL: "postgres://u@db.example.com:5432/darkfactory",
      DF_CONTROL_DATABASE_URL: "postgres://u@db.example.com:5432/darkfactory",
    });

    const refused = await preflightLocalRun({ env: hosted, ...TARGET, probes: HEALTHY });
    expect(codes(refused.problems)).toContain("remote-store-refused");

    const allowed = await preflightLocalRun({
      env: hosted,
      ...TARGET,
      probes: HEALTHY,
      allowRemoteStore: true,
    });
    expect(codes(allowed.problems)).not.toContain("remote-store-refused");
  });

  it("reports an unreachable store, naming the HOST and not the connection string", async () => {
    const result = await preflightLocalRun({
      env: completeEnv(),
      ...TARGET,
      probes: {
        ...HEALTHY,
        reachStore: async () => ({ ok: false, error: "ECONNREFUSED" }),
      },
    });

    expect(codes(result.problems)).toContain("store-unreachable");
    const problem = result.problems.find((p) => p.code === "store-unreachable");
    expect(problem?.fix).toContain("localhost");
    expect(problem?.fix).not.toContain("postgres://postgres@");
  });

  it("checks the sandbox seam when the driver is opensandbox, and not otherwise", async () => {
    const opened = await preflightLocalRun({
      env: completeEnv(),
      ...TARGET,
      probes: { ...HEALTHY, reachSandbox: async () => ({ ok: false, error: "connect ECONNREFUSED" }) },
    });
    expect(codes(opened.problems)).toContain("sandbox-unreachable");

    const stub = await preflightLocalRun({
      env: completeEnv({ DF_SANDBOX_DRIVER: "stub" }),
      ...TARGET,
      probes: { ...HEALTHY, reachSandbox: async () => ({ ok: false, error: "connect ECONNREFUSED" }) },
    });
    expect(codes(stub.problems)).not.toContain("sandbox-unreachable");
  });

  it("reports the opensandbox image as missing when the driver is opensandbox", async () => {
    const result = await preflightLocalRun({
      env: completeEnv({ DF_SANDBOX_IMAGE: "" }),
      ...TARGET,
      probes: HEALTHY,
    });

    expect(codes(result.problems)).toContain("sandbox-not-configured");
  });

  it("reports a claim another run still holds, naming the holder and its status", async () => {
    const result = await preflightLocalRun({
      env: completeEnv(),
      ...TARGET,
      probes: {
        ...HEALTHY,
        activeClaim: async () => ({
          ok: true,
          holder: { runId: "fda63901-8973-4c09-b6f9-bd14b62b4b8e", status: "blocked" },
        }),
      },
    });

    expect(codes(result.problems)).toContain("claim-held");
    const problem = result.problems.find((p) => p.code === "claim-held");
    expect(problem?.subject).toContain("fda63901");
    expect(problem?.fix).toMatch(/blocked|finish|retire/i);
    // #404 R2 Task 5: the refusal must name the ACTION, not merely the options — that is the whole complaint
    // about "wait, or retire it" with nothing to run.
    expect((problem?.fix ?? "").toLowerCase()).toContain("df:retire-claim");
  });

  it("SKIPS a check whose probe is absent - it never claims a check it did not run", async () => {
    const result = await preflightLocalRun({
      env: completeEnv(),
      ...TARGET,
      probes: {},
    });

    expect(result.ok).toBe(true);
    expect(codes(result.problems)).not.toContain("store-unreachable");
    expect(codes(result.problems)).not.toContain("sandbox-unreachable");
  });

  it("orders problems deterministically, whatever order the environment is checked in", async () => {
    const env = completeEnv({
      GITHUB_TOKEN: undefined,
      OPENROUTER_API_KEY: undefined,
      DF_WORKER_ALLOWED_REPOS: "",
      DF_RUN_HISTORY_DATABASE_URL: undefined,
      DF_CONTROL_DATABASE_URL: undefined,
      DF_SANDBOX_IMAGE: "",
    });

    const first = await preflightLocalRun({ env, ...TARGET, probes: HEALTHY });
    const second = await preflightLocalRun({ env, ...TARGET, probes: HEALTHY });

    expect(first.problems.length).toBeGreaterThanOrEqual(5);
    expect(codes(first.problems)).toEqual(codes(second.problems));
  });
});
