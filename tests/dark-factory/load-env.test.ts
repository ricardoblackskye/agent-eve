import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLocalEnv } from "../../scripts/load-env";

const KEYS = ["DF_TEST_ALPHA", "DF_TEST_BETA", "DF_TEST_QUOTED"] as const;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "df-env-"));
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of KEYS) delete process.env[key];
});

describe("operator script env loading (#215)", () => {
  it("supplies what the shell did not provide, and reports it", () => {
    writeFileSync(join(dir, ".env.local"), "DF_TEST_ALPHA=from-file\n");
    const supplied = loadLocalEnv(dir);
    expect(process.env.DF_TEST_ALPHA).toBe("from-file");
    expect(supplied).toContain("DF_TEST_ALPHA");
  });

  it("never overrides an explicitly exported value", () => {
    writeFileSync(join(dir, ".env.local"), "DF_TEST_BETA=from-file\n");
    process.env.DF_TEST_BETA = "from-shell";
    loadLocalEnv(dir);
    expect(process.env.DF_TEST_BETA).toBe("from-shell");
  });

  it("strips surrounding quotes and ignores comments and blanks", () => {
    writeFileSync(
      join(dir, ".env.local"),
      '# a comment\n\nexport DF_TEST_QUOTED="quoted value"\n',
    );
    loadLocalEnv(dir);
    expect(process.env.DF_TEST_QUOTED).toBe("quoted value");
  });

  it("is a no-op when there is no env file", () => {
    expect(loadLocalEnv(dir)).toEqual([]);
  });
});
