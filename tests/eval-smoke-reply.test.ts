import { describe, expect, it } from "vitest";

import { evaluateSmokeReply } from "../evals/helpers/smoke-reply";

// The exact reply that failed in Production. It is a good answer: the smoke test exists to prove
// the agent boots and says what it can do, and this does that.
const productionReply = `Hi! I'm Eve Agent - here's what I can actually help with:

**General work**
- Answer questions, analyze information, and search the web (with sources cited)`;

describe("smoke reply verdict (#444)", () => {
  it("C1 passes for the real Production reply that failed the old assertion", () => {
    expect(evaluateSmokeReply(productionReply).ok).toBe(true);
  });

  it("C2 passes for a simple helpful greeting reply", () => {
    const verdict = evaluateSmokeReply("Hello! I can help you with questions and research.");
    expect(verdict.ok).toBe(true);
  });

  it("C3 fails for an empty reply, and never throws", () => {
    for (const reply of ["", "   ", null, undefined]) {
      expect(() => evaluateSmokeReply(reply)).not.toThrow();
      expect(evaluateSmokeReply(reply).ok).toBe(false);
    }
  });

  it("C4 fails for a reply that does not say what the agent can help with", () => {
    // Anti-vacuity: without this the verdict would pass for any non-empty string.
    const verdict = evaluateSmokeReply("Hi! I'm Eve Agent.");
    expect(verdict.ok).toBe(false);
  });
});
