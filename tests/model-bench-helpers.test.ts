/**
 * Unit tests for the model-benchmark policy helpers (issue #121 / #122).
 *
 * These test the LATENCY and QUALITY *policy* deterministically, with no
 * network and no API key — so the guard logic is proven even where the live
 * benchmark must skip. The live measurement (`measureLatency`) is covered by
 * the skippable contract tests.
 */
import { describe, it, expect } from "vitest";
import {
  assertLatencyWithinBudget,
  gradeStoryQuality,
  type LatencyBudget,
  type QualityGate,
} from "./helpers/model-bench";

const budget: LatencyBudget = {
  ceilingMs: 30000,
  baselineMs: 10000,
  tolerance: 1.5,
};

describe("assertLatencyWithinBudget", () => {
  it("passes when well under ceiling and baseline", () => {
    expect(assertLatencyWithinBudget({ ttftMs: 800, totalMs: 4000 }, budget)).toEqual(
      [],
    );
  });

  it("flags a hard ceiling breach even with no baseline", () => {
    const b: LatencyBudget = { ceilingMs: 5000, baselineMs: null, tolerance: 1.5 };
    const v = assertLatencyWithinBudget({ ttftMs: 6000, totalMs: 9000 }, b);
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x.kind === "ceiling")).toBe(true);
  });

  it("flags a baseline-ratio breach (within ceiling but > baseline*tolerance)", () => {
    // baseline 10000, tolerance 1.5 -> limit 15000; total 20000 breaches.
    const v = assertLatencyWithinBudget({ ttftMs: 900, totalMs: 20000 }, budget);
    expect(v.some((x) => x.kind === "baseline" && x.metric === "totalMs")).toBe(true);
  });

  it("does not flag when between ceiling and baseline limit", () => {
    // 12000 < 15000 limit and < 30000 ceiling -> clean.
    expect(assertLatencyWithinBudget({ ttftMs: 900, totalMs: 12000 }, budget)).toEqual(
      [],
    );
  });
});

const gate: QualityGate = {
  minChars: 30,
  requiredSections: ["intent", "acceptance"],
  refusalMarkers: ["i cannot", "error:", "rate limit"],
};

describe("gradeStoryQuality", () => {
  it("passes a well-structured story", () => {
    const out = gradeStoryQuality(
      "Intent: the agent retries failed webhooks automatically.\nAcceptance Criteria: it retries up to three times with exponential backoff and alerts on final failure.",
      gate,
    );
    expect(out.passed).toBe(true);
    expect(out.failures).toEqual([]);
  });

  it("fails a too-short / truncated output", () => {
    const out = gradeStoryQuality("Intent: retry.", gate);
    expect(out.passed).toBe(false);
    expect(out.failures.some((f) => f.includes("too short"))).toBe(true);
  });

  it("fails when a required section is missing", () => {
    const out = gradeStoryQuality(
      "Intent: the agent retries failed webhooks automatically. This is a sensible improvement to reliability.",
      gate,
    );
    expect(out.passed).toBe(false);
    expect(out.failures.some((f) => f.toLowerCase().includes("acceptance"))).toBe(
      true,
    );
  });

  it("fails on a refusal/error marker", () => {
    const out = gradeStoryQuality(
      "I cannot help with that. Error: the request is unsupported by this model.",
      gate,
    );
    expect(out.passed).toBe(false);
    expect(out.failures.some((f) => f.toLowerCase().includes("refusal"))).toBe(true);
  });

  it("is case-insensitive on section markers", () => {
    const out = gradeStoryQuality(
      "INTENT: retry failed webhooks.\nACCEPTANCE: three attempts with backoff before giving up.",
      gate,
    );
    expect(out.passed).toBe(true);
  });
});
