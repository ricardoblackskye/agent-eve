/**
 * Pure decisions behind the `df:cost-budget` operator CLI (follow-up to #478).
 *
 * The CLI's `main()` is not unit-tested (it prints and exits); the DECISIONS it
 * makes are, so a wrong period or an unsafe cap cannot ship behind a green CLI.
 *
 * Every case that expects a THROW asserts a valid value first: against a
 * throwing stub the throw-cases would otherwise pass for the wrong reason and
 * the RED would prove nothing.
 */
import { describe, expect, it } from "vitest";
import {
  computeToppedUpCap,
  parseCostBudgetArgs,
  resolveBudgetPeriod,
  toCostCategory,
} from "../../agent/lib/dark-factory/cost-budget-admin";

describe("parseCostBudgetArgs", () => {
  it("separates the command from its flags", () => {
    const parsed = parseCostBudgetArgs([
      "set",
      "--category",
      "orchestrator",
      "--cap",
      "100",
    ]);
    expect(parsed.command).toBe("set");
    expect(parsed.flags).toEqual({ category: "orchestrator", cap: "100" });
  });

  it("treats a flag followed by another flag as missing its value", () => {
    const parsed = parseCostBudgetArgs([
      "add",
      "--category",
      "orchestrator",
      "--amount",
      "5",
    ]);
    expect(parsed.flags).toEqual({ category: "orchestrator", amount: "5" });

    expect(() =>
      parseCostBudgetArgs(["add", "--category", "--amount", "5"]),
    ).toThrow(/Missing value for --category/);
  });
});

describe("resolveBudgetPeriod", () => {
  it("uses a concrete configured period", () => {
    expect(resolveBudgetPeriod({ DF_COST_BUDGET_PERIOD: "2026-07" })).toBe(
      "2026-07",
    );
  });

  it("falls back to the current UTC month when the period is unset or the placeholder", () => {
    const now = new Date("2026-10-26T09:00:00.000Z");
    expect(resolveBudgetPeriod({}, now)).toBe("2026-10");
    // The documented default is the literal placeholder, which is not a concrete period.
    expect(resolveBudgetPeriod({ DF_COST_BUDGET_PERIOD: "YYYY-MM" }, now)).toBe(
      "2026-10",
    );
  });
});

describe("computeToppedUpCap", () => {
  it("adds the amount to the current cap", () => {
    expect(computeToppedUpCap(30, 50)).toBe(80);
  });

  it("rejects a non-finite amount", () => {
    expect(computeToppedUpCap(30, 0)).toBe(30);
    expect(() => computeToppedUpCap(30, Number.NaN)).toThrow(/finite/i);
    expect(() => computeToppedUpCap(30, Number.POSITIVE_INFINITY)).toThrow(
      /finite/i,
    );
  });

  it("rejects a top-up that would drive the cap below zero", () => {
    expect(computeToppedUpCap(10, -10)).toBe(0);
    expect(() => computeToppedUpCap(10, -20)).toThrow(/negative/i);
  });
});

describe("toCostCategory", () => {
  it("accepts a canonical category", () => {
    expect(toCostCategory("orchestrator")).toBe("orchestrator");
  });

  it("rejects an unknown category", () => {
    expect(toCostCategory("pr-review")).toBe("pr-review");
    expect(() => toCostCategory("nope")).toThrow(/category/i);
  });
});
