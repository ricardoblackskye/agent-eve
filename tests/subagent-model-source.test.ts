/**
 * Drift guard (issue #121 / #122): every subagent resolver must source its
 * default model id from the shared `agent/model-config.ts` rather than
 * hardcoding the previous model. If someone copies an old `DEFAULT_MODEL =
 * "deepseek/deepseek-v4-pro"` literal back into a subagent, this test fails.
 *
 * `release-manager` is intentionally exempt: it uses a different model
 * (Nemotron) by design and is not "the Eve model" the issue refers to.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const EXEMPT = new Set(["release-manager"]);

// Subagent directories that should resolve the shared Eve default.
const SUBAGENTS = ["product-owner", "sprint-reporter"];

describe("subagent model source (no hardcoded old default)", () => {
  for (const name of SUBAGENTS) {
    if (EXEMPT.has(name)) continue;
    it(`${name} imports the shared default, not a hardcoded old id`, () => {
      const file = join(ROOT, "agent", "subagents", name, "agent.ts");
      const src = readFileSync(file, "utf8");

      // Must pull the canonical default from the shared module.
      expect(src, `${name} should import DEFAULT_MODEL_ID from model-config`).toMatch(
        /DEFAULT_MODEL_ID/,
      );
      expect(src, `${name} should import from agent/model-config`).toMatch(
        /from\s+["']\.\.\/\.\.\/model-config["']|from\s+["']\.\.\/model-config["']|from\s+["']\.\.\/\.\.\/\.\.\/agent\/model-config["']/,
      );
      // The previous default must not appear as a hardcoded literal.
      expect(
        src,
        `${name} must not hardcode the old deepseek-v4-pro default`,
      ).not.toMatch(/DEFAULT_MODEL\s*=\s*["']deepseek\/deepseek-v4-pro["']/);
      expect(src).not.toMatch(/openrouter\.chat\(\s*["']deepseek\/deepseek-v4-pro["']\s*\)/);
    });
  }

  it("release-manager is exempt (intentionally a different model)", () => {
    const file = join(ROOT, "agent", "subagents", "release-manager", "agent.ts");
    const src = readFileSync(file, "utf8");
    // Sanity: release-manager still resolves to its own (non-v4.1-flash) model.
    expect(src).toMatch(/nemotron/i);
  });
});
