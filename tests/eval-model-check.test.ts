import { describe, expect, it } from "vitest";

import { evaluateModelCheck } from "../evals/helpers/model-check";

// The two shapes AgentInfoResultSchema permits, plus the failure envelopes it does not.
const governed = { agent: { model: { routing: { kind: "dynamic" } } } };
const staticDeepseek = {
  agent: { model: { id: "deepseek/deepseek-chat", routing: { kind: "gateway" } } },
};
const staticOther = {
  agent: { model: { id: "anthropic/claude-sonnet-5", routing: { kind: "gateway" } } },
};
const unauthorizedEnvelope = {
  code: "unauthorized",
  error: "Invalid or missing API key.",
  ok: false,
};

describe("model-check verdict (#440)", () => {
  it("C1 passes for a governed model and names the governed case", () => {
    const verdict = evaluateModelCheck(governed);
    expect(verdict.ok).toBe(true);
    // The message must say the model is governed, so a reader is not sent hunting for an id.
    expect(verdict.message).toMatch(/dynamic|governed/i);
  });

  it("C2 passes for a static deepseek id and names it", () => {
    const verdict = evaluateModelCheck(staticDeepseek);
    expect(verdict.ok).toBe(true);
    expect(verdict.message).toContain("deepseek/deepseek-chat");
  });

  it("C3 fails for a different static model", () => {
    // Anti-vacuity: if this ever passes, the check has been loosened into "always pass".
    const verdict = evaluateModelCheck(staticOther);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("anthropic/claude-sonnet-5");
  });

  it("C4 fails cleanly when no model is reported, and never throws", () => {
    for (const payload of [unauthorizedEnvelope, {}, { agent: {} }, null, undefined]) {
      expect(() => evaluateModelCheck(payload)).not.toThrow();
      const verdict = evaluateModelCheck(payload);
      expect(verdict.ok).toBe(false);
      // The failure must name the absent field rather than surfacing a TypeError.
      expect(verdict.message).toMatch(/agent\.model|no model/i);
    }
  });

  it("C5 states which case was proven, not just a bare pass", () => {
    expect(evaluateModelCheck(governed).message).not.toBe(
      evaluateModelCheck(staticDeepseek).message,
    );
  });
});
