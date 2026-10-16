import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  RUNNER_CONFIG_PATH,
  authorizeTargetRepo,
  loadRunnerConfig,
  parseRunnerConfig,
  resolveBoard,
  resolveBoardSetting,
  resolveBranchName,
  resolveIssueNumber,
  resolveRepoSettings,
  resolveTargetRepo,
  type RunnerConfig,
} from "../../agent/lib/dark-factory/runner-config";

/** argv as the runner actually receives it: node + script, then the flags. */
const argv = (...flags: string[]): string[] => [
  "node",
  "scripts/dark-factory-runner.ts",
  ...flags,
];

const CONFIG: RunnerConfig = { defaultRepo: "ricardoblackskye/agent-eve" };

describe("resolveTargetRepo", () => {
  it("takes the repository from an explicit --repo, which beats the configured default", () => {
    const result = resolveTargetRepo({
      argv: argv("--issue", "348", "--repo", "ricardoblackskye/WebFeedPOC"),
      config: CONFIG,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repo).toBe("ricardoblackskye/webfeedpoc");
      expect(result.source).toBe("argument");
    }
  });

  it("falls back to the configured default when no --repo is given", () => {
    const result = resolveTargetRepo({ argv: argv("--issue", "348"), config: CONFIG });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repo).toBe("ricardoblackskye/agent-eve");
      expect(result.source).toBe("config");
    }
  });

  it("normalises casing, so it cannot disagree with the allow-list about identity", () => {
    // GitHub treats owner casing as insignificant, and the allow-list parser lower-cases its entries.
    // Without this, a correctly-authorized repo could fail the membership check on case alone.
    const result = resolveTargetRepo({
      argv: argv("--repo", "RicardoBlackSkye/Agent-Eve"),
      config: {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.repo).toBe("ricardoblackskye/agent-eve");
  });

  it("refuses a malformed --repo, quoting the value, rather than coercing it", () => {
    for (const bad of ["agent-eve", "a/b/c", "owner/", "own er/repo"]) {
      const result = resolveTargetRepo({ argv: argv("--repo", bad), config: {} });

      expect(result.ok, `expected ${JSON.stringify(bad)} to be refused`).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("--repo");
        expect(result.error).toContain(bad);
      }
    }
  });

  it("refuses a --repo with no value after it, instead of silently using the default", () => {
    const result = resolveTargetRepo({ argv: argv("--issue", "348", "--repo"), config: CONFIG });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("--repo");
  });

  it("refuses when neither an argument nor a default exists, naming both ways to supply one", () => {
    const result = resolveTargetRepo({ argv: argv("--issue", "348"), config: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("--repo");
      expect(result.error).toContain("default_repo");
    }
  });

  it("refuses a malformed default in the config — a bad config must not become a bad run", () => {
    // Validated here as well as at load time: a config built in code never passes through the loader.
    const result = resolveTargetRepo({
      argv: argv("--issue", "348"),
      config: { defaultRepo: "agent-eve" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("default_repo");
  });
});

describe("runner config loading", () => {
  const PATH = "dark-factory.config.json";

  const enoent = (): never => {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  };

  it("reads default_repo from a well-formed config", () => {
    const result = parseRunnerConfig('{"default_repo": "ricardoblackskye/WebFeedPOC"}');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.defaultRepo).toBe("ricardoblackskye/WebFeedPOC");
    }
  });

  it("loads through the injected reader, so no test touches the real filesystem", () => {
    const result = loadRunnerConfig({
      readFile: () => '{"default_repo": "ricardoblackskye/agent-eve"}',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.defaultRepo).toBe("ricardoblackskye/agent-eve");
  });

  it("treats a missing config as no default, not as an error", () => {
    // The config supplies a DEFAULT, and --repo alone is legitimate. With neither, the run refuses in
    // resolveTargetRepo - so an absent file is not itself a failure.
    const result = loadRunnerConfig({ readFile: enoent });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.defaultRepo).toBeUndefined();
  });

  it("refuses malformed JSON, naming the file", () => {
    const result = parseRunnerConfig("{ not json", PATH);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(PATH);
  });

  it("refuses a config that is not an object at all", () => {
    const result = parseRunnerConfig('["not", "an", "object"]', PATH);

    expect(result.ok).toBe(false);
  });

  it("refuses a default_repo that is not an owner/repo pair", () => {
    const result = parseRunnerConfig('{"default_repo": "agent-eve"}', PATH);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("default_repo");
  });

  it("refuses a default_repo of the wrong SHAPE instead of reading it as text", () => {
    // A truthiness check accepts every one of these, and the value then reaches a repo-pair test that
    // coerces it. Validate the type, not the presence.
    for (const bad of ["42", "null", "true", '["a/b"]', '{"owner":"a"}']) {
      const result = parseRunnerConfig(`{"default_repo": ${bad}}`, PATH);

      expect(result.ok, `expected ${bad} to be refused`).toBe(false);
      if (!result.ok) expect(result.error).toContain("default_repo");
    }
  });
});

describe("authorizeTargetRepo", () => {
  it("refuses every repository when the allow-list is unset, naming the variable", () => {
    // This is the path the runner used to make unreachable by SETTING the variable when it was unset, so
    // an unconfigured deployment looked authorized instead of refusing.
    const result = authorizeTargetRepo({ repo: "ricardoblackskye/agent-eve", allowed: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("DF_WORKER_ALLOWED_REPOS");
  });

  it("refuses a repository outside the list, naming the repo and the list", () => {
    const result = authorizeTargetRepo({
      repo: "ricardoblackskye/WebFeedPOC",
      allowed: ["ricardoblackskye/agent-eve"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ricardoblackskye/WebFeedPOC");
      expect(result.error).toContain("ricardoblackskye/agent-eve");
    }
  });

  it("allows a listed repository", () => {
    expect(
      authorizeTargetRepo({
        repo: "ricardoblackskye/agent-eve",
        allowed: ["ricardoblackskye/agent-eve", "ricardoblackskye/WebFeedPOC"],
      }).ok,
    ).toBe(true);
  });

  it("compares without regard to case, matching how the allow-list is parsed", () => {
    // resolveWorkerAllowedRepos lower-cases its entries, so a caller that hands over the configured
    // casing must not be refused on spelling.
    expect(
      authorizeTargetRepo({
        repo: "RicardoBlackSkye/Agent-Eve",
        allowed: ["ricardoblackskye/agent-eve"],
      }).ok,
    ).toBe(true);
  });
});

describe("the runner's wiring (#348)", () => {
  const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");

  it("no longer invents an allow-list when none is configured", () => {
    expect(runner).not.toMatch(/process\.env\.DF_WORKER_ALLOWED_REPOS\s*=/);
  });

  it("no longer hardcodes the target repository", () => {
    expect(runner).not.toContain('"ricardoblackskye/agent-eve"');
  });

  it("resolves and authorizes the repository through the module", () => {
    expect(runner).toContain("resolveTargetRepo(");
    expect(runner).toContain("authorizeTargetRepo(");
  });
});

describe("resolveIssueNumber", () => {
  it("reads the issue from --issue", () => {
    const result = resolveIssueNumber(argv("--issue", "348"));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.issue).toBe(348);
  });

  it("refuses an absent --issue instead of running a default issue nobody asked for", () => {
    // The runner used to default to 179, silently.
    const result = resolveIssueNumber(argv("--repo", "owner/name"));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("--issue");
  });

  it("refuses a non-numeric, fractional, empty or valueless --issue rather than coercing it", () => {
    // `parseInt("34.8")` is 34 and `parseInt("12abc")` is 12: parseInt coerces rather than validates, so
    // the digits check is the control, not a nicety.
    for (const args of [
      ["--issue", "abc"],
      ["--issue", "34.8"],
      ["--issue", "12abc"],
      ["--issue", "-5"],
      ["--issue", ""],
      ["--issue"],
    ]) {
      const result = resolveIssueNumber(argv(...args));
      expect(result.ok, `expected ${JSON.stringify(args)} to be refused`).toBe(false);
    }
  });
});

describe("resolveBranchName", () => {
  it("uses an explicit --branch", () => {
    const result = resolveBranchName({
      argv: argv("--branch", "feat/thing-348"),
      issue: 348,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.branch).toBe("feat/thing-348");
  });

  it("derives a default branch name containing no '#'", () => {
    // The old default was `feat/dark-factory-#${issue}` — a `#` in a branch name breaks the GitHub UI and
    // URLs, and this repo's own convention forbids it.
    const result = resolveBranchName({ argv: argv("--issue", "348"), issue: 348 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.branch).toContain("348");
      expect(result.branch).not.toContain("#");
    }
  });

  it("refuses a bare --branch rather than silently defaulting", () => {
    const result = resolveBranchName({ argv: argv("--branch"), issue: 348 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("--branch");
  });
});

describe("per-repo settings (#348 R2)", () => {
  const CONFIG: RunnerConfig = {
    defaultRepo: "ricardoblackskye/agent-eve",
    repos: {
      "ricardoblackskye/agent-eve": { board: { login: "ricardoblackskye", number: 3 } },
      "ricardoblackskye/WebFeedPOC": { board: { login: "ricardoblackskye", number: 7 } },
    },
  };

  it("reads the board for a listed repo", () => {
    const result = resolveRepoSettings({ repo: "ricardoblackskye/agent-eve", config: CONFIG });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.board).toEqual({ login: "ricardoblackskye", number: 3 });
    }
  });

  it("does not leak another repository's board", () => {
    const result = resolveRepoSettings({ repo: "ricardoblackskye/WebFeedPOC", config: CONFIG });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.settings.board?.number).toBe(7);
  });

  it("matches the repo key without regard to case", () => {
    const result = resolveRepoSettings({ repo: "RicardoBlackSkye/Agent-Eve", config: CONFIG });

    expect(result.ok).toBe(true);
  });

  it("refuses a repo with no entry, naming the repo AND the file", () => {
    // The alternative is the behaviour being replaced: silently reporting to board 3.
    const result = resolveRepoSettings({ repo: "someone/other", config: CONFIG });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("someone/other");
      expect(result.error).toContain(RUNNER_CONFIG_PATH);
    }
  });

  it("refuses when the config has no repos map at all, naming the file", () => {
    const result = resolveRepoSettings({
      repo: "ricardoblackskye/agent-eve",
      config: { defaultRepo: "ricardoblackskye/agent-eve" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(RUNNER_CONFIG_PATH);
  });

  it("refuses a malformed board by SHAPE instead of reading it as text", () => {
    // A truthiness check accepts every one of these and the value then reaches a GitHub call.
    for (const bad of [
      { login: "ricardoblackskye", number: "3" },
      { login: "ricardoblackskye" },
      { login: "", number: 3 },
      { login: "   ", number: 3 },
      { number: 3 },
      { login: "ricardoblackskye", number: 3.5 },
      { login: "ricardoblackskye", number: -1 },
      "board",
      ["board"],
      null,
    ]) {
      const result = resolveRepoSettings({
        repo: "a/b",
        config: { repos: { "a/b": { board: bad as never } } },
      });

      expect(result.ok, `expected ${JSON.stringify(bad)} to be refused`).toBe(false);
    }
  });

  it("resolveBoard returns the board, or refuses naming the repo and the file", () => {
    const found = resolveBoard({ repo: "ricardoblackskye/agent-eve", config: CONFIG });

    expect(found.ok).toBe(true);
    if (found.ok) expect(found.board.number).toBe(3);

    const missing = resolveBoard({ repo: "a/b", config: { repos: { "a/b": {} } } });

    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error).toContain("a/b");
      expect(missing.error).toContain(RUNNER_CONFIG_PATH);
    }
  });

  it("parses a repos map out of the file", () => {
    const parsed = parseRunnerConfig(
      JSON.stringify({
        default_repo: "ricardoblackskye/agent-eve",
        repos: {
          "ricardoblackskye/agent-eve": { board: { login: "ricardoblackskye", number: 3 } },
        },
      }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.config.repos?.["ricardoblackskye/agent-eve"]?.board?.number).toBe(3);
    }
  });

  it("still accepts a config with no repos at all, so R1's file keeps working", () => {
    const parsed = parseRunnerConfig('{"default_repo": "ricardoblackskye/agent-eve"}');

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.repos).toBeUndefined();
  });

  it("refuses a repos key that is not an owner/repo pair, naming the key", () => {
    const parsed = parseRunnerConfig('{"repos": {"not-a-pair": {}}}');

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("not-a-pair");
  });

  it("refuses a malformed board at LOAD time as well as at use", () => {
    // The loader is not the only door: a config built in code is validated in resolveRepoSettings too.
    const parsed = parseRunnerConfig('{"repos": {"a/b": {"board": {"login": "x"}}}}');

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("board");
  });

  it("the SHIPPED config file parses and still gives agent-eve its board", () => {
    // A characterization guard, not a RED - the file already parses, so this passes on first run. It exists
    // because the board used to be hardcoded in the sprint reporter, which makes this file the only place
    // that value now lives: an edit to it should have to break a test rather than silently move a
    // repository's reporting to a different Project.
    const loaded = loadRunnerConfig();

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const board = resolveBoard({
      repo: "ricardoblackskye/agent-eve",
      config: loaded.config,
    });

    expect(board.ok).toBe(true);
    if (board.ok) {
      expect(board.board).toEqual({ login: "ricardoblackskye", number: 3 });
    }
  });
});

describe("resolveBoardSetting (#348 R2 Task 2)", () => {
  const CONFIG: RunnerConfig = {
    repos: { "owner/name": { board: { login: "config-login", number: 5 } } },
  };

  it("takes both halves from an explicit argument", () => {
    const result = resolveBoardSetting({
      repo: "owner/name",
      config: CONFIG,
      explicit: { login: "arg-login", number: 9 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.login).toBe("arg-login");
      expect(result.number).toBe(9);
      expect(result.sources).toEqual({ login: "argument", number: "argument" });
    }
  });

  it("resolves each half independently: environment first, then config", () => {
    const both = resolveBoardSetting({
      repo: "owner/name",
      config: CONFIG,
      env: { SPRINT_PROJECT_OWNER: "env-login", SPRINT_PROJECT_NUMBER: "7" },
    });

    expect(both.ok).toBe(true);
    if (both.ok) {
      expect(both.login).toBe("env-login");
      expect(both.number).toBe(7);
      expect(both.sources).toEqual({ login: "env", number: "env" });
    }

    const mixed = resolveBoardSetting({
      repo: "owner/name",
      config: CONFIG,
      env: { SPRINT_PROJECT_OWNER: "env-login" },
    });

    expect(mixed.ok).toBe(true);
    if (mixed.ok) {
      expect(mixed.login).toBe("env-login");
      expect(mixed.number).toBe(5);
      expect(mixed.sources).toEqual({ login: "env", number: "config" });
    }
  });

  it("takes both halves from config when nothing overrides them", () => {
    const result = resolveBoardSetting({ repo: "owner/name", config: CONFIG });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.login).toBe("config-login");
      expect(result.number).toBe(5);
      expect(result.sources).toEqual({ login: "config", number: "config" });
    }
  });

  it("refuses when nothing supplies a value, naming the repo and every way to set one", () => {
    const result = resolveBoardSetting({ repo: "someone/other", config: CONFIG });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("someone/other");
      expect(result.error).toContain("SPRINT_PROJECT_OWNER");
      expect(result.error).toContain("SPRINT_PROJECT_NUMBER");
      expect(result.error).toContain(RUNNER_CONFIG_PATH);
    }
  });

  it("refuses a malformed environment override instead of coercing it", () => {
    // The replaced expression was `Number(process.env.SPRINT_PROJECT_NUMBER || 3)`: Number("abc") is NaN
    // and Number("3.7") is 3.7, so a typo became a board number nobody chose.
    for (const bad of ["abc", "3.7", "-1", "0"]) {
      const result = resolveBoardSetting({
        repo: "owner/name",
        config: CONFIG,
        env: { SPRINT_PROJECT_NUMBER: bad },
      });

      expect(result.ok, `expected ${JSON.stringify(bad)} to be refused`).toBe(false);
    }
  });

  it("treats a BLANK explicit value as unset, and falls through rather than failing", () => {
    const result = resolveBoardSetting({
      repo: "owner/name",
      config: CONFIG,
      explicit: { login: "   " },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.login).toBe("config-login");
      expect(result.sources.login).toBe("config");
    }
  });

  it("refuses an explicit project number that is not a positive integer", () => {
    for (const bad of [0, -1, 2.5]) {
      const result = resolveBoardSetting({
        repo: "owner/name",
        config: CONFIG,
        explicit: { number: bad },
      });

      expect(result.ok, `expected ${bad} to be refused`).toBe(false);
    }
  });
});

describe("the runner's other invented inputs (#348)", () => {
  const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");

  it("no longer defaults the issue number", () => {
    expect(runner).not.toContain(": 179;");
  });

  it("no longer builds a branch name containing '#'", () => {
    expect(runner).not.toContain("feat/dark-factory-#");
  });

  it("takes both from the module", () => {
    expect(runner).toContain("resolveIssueNumber(");
    expect(runner).toContain("resolveBranchName(");
  });
});
