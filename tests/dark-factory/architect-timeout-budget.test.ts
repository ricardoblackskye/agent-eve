import { describe, expect, it } from "vitest";

import {
  ARCHITECT_TIMEOUT_FLOOR_MS,
  ARCHITECT_TIMEOUT_MAX_MS,
  ARCHITECT_TIMEOUT_OVERHEAD_FREE_CHARS,
  architectTimeoutBudgetMs,
  resolveArchitectTimeoutMs,
} from "../../agent/lib/dark-factory/architect-agent";

/**
 * #521 — the Architect's planning budget against a large discovery read.
 *
 * The bug: a FIXED per-attempt wall-clock budget (`deps.timeoutMs ?? 60000`, never passed by the runner and
 * with no environment variable) against a prompt budget of 400,000 chars and discovery evidence of up to
 * 24 x 12,000 = 288,000 chars. A cross-cutting story could not finish a single attempt, so it failed to plan
 * at all (run df572110), while a one-file story on the same repository finished on attempt 1.
 *
 * These pin the two new seams: an operator override, and a budget derived from the thing that actually drives
 * latency — the prompt.
 */
describe("#521 the Architect's planning budget", () => {
  describe("the operator override", () => {
    it("is absent unless set, so the budget is derived from the prompt", () => {
      expect(resolveArchitectTimeoutMs({})).toBeUndefined();
    });

    it("wins when set", () => {
      expect(resolveArchitectTimeoutMs({ DF_ARCHITECT_TIMEOUT_MS: "180000" })).toBe(180000);
    });

    it("fails closed on a value that is not a positive integer", () => {
      // A VALID value is asserted FIRST on purpose: every toThrow() case below would otherwise pass for the
      // wrong reason against an unimplemented stub, and the RED would look honest while proving nothing.
      expect(resolveArchitectTimeoutMs({ DF_ARCHITECT_TIMEOUT_MS: "600001" })).toBe(600001);
      // Mirrors DF_TESTER_TIMEOUT_MS: a misconfiguration is caught when the run starts, not by a run that
      // silently holds an attempt open for the wrong budget.
      for (const bad of ["", "abc", "0", "-1", "12.5"]) {
        expect(() => resolveArchitectTimeoutMs({ DF_ARCHITECT_TIMEOUT_MS: bad })).toThrow();
      }
    });
  });

  describe("the derived budget", () => {
    /** MAX_CONTEXT_FILES_READ x MAX_CHARS_PER_FILE: the most evidence one attempt can carry. */
    const FULL_EVIDENCE_CHARS = 24 * 12_000;

    it("keeps the floor for a small prompt, so small stories are unchanged", () => {
      expect(architectTimeoutBudgetMs(2_000)).toBe(ARCHITECT_TIMEOUT_FLOOR_MS);
    });

    it("keeps the floor up to the threshold and scales only above it (exact boundary)", () => {
      // An off-by-one in a `<=` guard is invisible to an above/below pair, so the boundary itself is asserted.
      expect(architectTimeoutBudgetMs(ARCHITECT_TIMEOUT_OVERHEAD_FREE_CHARS)).toBe(
        ARCHITECT_TIMEOUT_FLOOR_MS,
      );
      expect(architectTimeoutBudgetMs(ARCHITECT_TIMEOUT_OVERHEAD_FREE_CHARS + 1)).toBeGreaterThan(
        ARCHITECT_TIMEOUT_FLOOR_MS,
      );
    });

    it("gives a full-evidence prompt materially more than the floor", () => {
      expect(architectTimeoutBudgetMs(FULL_EVIDENCE_CHARS)).toBeGreaterThan(
        ARCHITECT_TIMEOUT_FLOOR_MS,
      );
    });

    it("grows with the prompt, so the budget tracks what actually drives latency", () => {
      expect(architectTimeoutBudgetMs(400_000)).toBeGreaterThan(
        architectTimeoutBudgetMs(100_000),
      );
    });

    it("yields to an explicit budget whatever the prompt", () => {
      expect(architectTimeoutBudgetMs(FULL_EVIDENCE_CHARS, 5_000)).toBe(5_000);
    });

    it("treats a nonsense size as no evidence rather than as an unbounded budget", () => {
      // A NaN reaching the timer would make setTimeout fire immediately; Infinity would never fire.
      for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
        expect(architectTimeoutBudgetMs(bad)).toBe(ARCHITECT_TIMEOUT_FLOOR_MS);
      }
    });

    it("caps the derived budget, so a stuck attempt cannot be held open without bound", () => {
      const huge = architectTimeoutBudgetMs(50_000_000);
      expect(Number.isFinite(huge)).toBe(true);
      expect(huge).toBeLessThanOrEqual(ARCHITECT_TIMEOUT_MAX_MS);
    });
  });
});
