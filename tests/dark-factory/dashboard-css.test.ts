import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #205: the LLM Cost Budgets and LLM Call Policy panels shipped with no CSS at
 * all (verified), and the panel-head role badges had no spacing. These guards
 * fail if that styling is dropped again.
 *
 * Read from disk (never a `?raw` import, which resolves to an empty string
 * under Vitest).
 */
const css = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

describe("dashboard CSS coverage", () => {
  it("styles the LLM cost-budget panel", () => {
    expect(css).toMatch(/\.df-cost-/);
  });

  it("styles the LLM call-policy panel", () => {
    expect(css).toMatch(/\.df-policy-/);
  });

  it("styles the panel-head role badges as chips", () => {
    expect(css).toMatch(/\.df-chip\b/);
  });

  it("styles the outcome-mix table", () => {
    expect(css).toMatch(/\.df-mix-table\b/);
  });
});