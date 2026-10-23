import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initRunnerEnv } from "../agent/lib/dark-factory/runner-env";

const dirs: string[] = [];

function emptyCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "df-runner-env-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: a locked temp dir must not fail the assertions.
    }
  }
});

describe("runner env bootstrap (issue #400)", () => {
  it("does not invent EVE_CHAT_MODEL when it is absent", () => {
    const env: Record<string, string | undefined> = {};
    initRunnerEnv({ cwd: emptyCwd(), env });
    // A code default here would silently override agent/model-config.ts.
    expect(env.EVE_CHAT_MODEL).toBeUndefined();
  });

  it("preserves EVE_CHAT_MODEL when the operator set it", () => {
    const env: Record<string, string | undefined> = {
      EVE_CHAT_MODEL: "deepseek/deepseek-v4-pro",
    };
    initRunnerEnv({ cwd: emptyCwd(), env });
    expect(env.EVE_CHAT_MODEL).toBe("deepseek/deepseek-v4-pro");
  });

  it("loads key values from a .env file in the working directory", () => {
    const dir = emptyCwd();
    writeFileSync(join(dir, ".env"), "# comment\nOPENROUTER_API_KEY=abc123\n\nEVE_CHAT_MODEL=from-dotenv\n");
    const env: Record<string, string | undefined> = {};
    initRunnerEnv({ cwd: dir, env });
    expect(env.OPENROUTER_API_KEY).toBe("abc123");
    expect(env.EVE_CHAT_MODEL).toBe("from-dotenv");
  });

  it("does not touch process.env when an explicit env object is given", () => {
    const before = process.env.EVE_CHAT_MODEL;
    initRunnerEnv({ cwd: emptyCwd(), env: {} });
    expect(process.env.EVE_CHAT_MODEL).toBe(before);
  });
});
