import { describe, expect, it } from "vitest";
import {
  loadRunnerConfig,
  parseRunnerConfig,
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
