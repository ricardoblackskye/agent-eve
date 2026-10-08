/**
 * Drift guard (issue #121 / #122): every subagent resolver must source its
 * default model id from the shared `agent/model-config.ts` rather than
 * hardcoding the previous model. If someone copies an old `DEFAULT_MODEL =
 * "deepseek/deepseek-v4-pro"` literal back into a subagent, this test fails.
 *
 * `release-manager` previously used a hardcoded `:free` model (Nemotron) that is
 * absent from the price table; it now resolves the shared default too (#270).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

// Subagent directories that should resolve the shared Eve default.
const SUBAGENTS = ["product-owner", "sprint-reporter", "release-manager"];

describe("subagent model source (no hardcoded old default)", () => {
  for (const name of SUBAGENTS) {
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

  it("release-manager uses the priced shared default, not a hardcoded :free model", () => {
    const file = join(ROOT, "agent", "subagents", "release-manager", "agent.ts");
    const src = readFileSync(file, "utf8");
    // #270: a `:free` model is absent from the price table and would always be
    // refused by the cost gate, so the manager must resolve the shared default.
    expect(src).toMatch(/DEFAULT_MODEL_ID/);
    expect(src).not.toMatch(/nemotron/i);
  });
});
