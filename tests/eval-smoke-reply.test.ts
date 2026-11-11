import { describe, expect, it } from "vitest";

import { evaluateSmokeReply } from "../evals/helpers/smoke-reply";

// Three production greetings, captured verbatim from three separate runs. Each one is a good
// answer: the smoke test exists to prove the agent boots and says what it can do. The first two
// already broke earlier iterations of the check, which is why the verdict must be structural rather
// than a keyword allow-list (#444 -> #624 -> #626).
const reply444 = `Hi! I'm Eve Agent - here's what I can actually help with:

**General work**
- Answer questions, analyze information, and search the web (with sources cited)`;

const reply624 = `Hi! I'm Eve Agent. Here's what I can do:

**General work**
- Answer questions, analyze information, and search the web (with sources cited)`;

const reply626 = `Hi! I'm Eve Agent — I can dig into code and files, run commands, search the web,
and read what I find. What would you like me to look at?`;

describe("smoke reply verdict (#444 -> #624 -> #626)", () => {
  describe("passes for the greetings observed in production", () => {
    it("C1 passes for the original #444 production reply", () => {
      expect(evaluateSmokeReply(reply444).ok).toBe(true);
    });

    it("C2 passes for the #624 production reply", () => {
      expect(evaluateSmokeReply(reply624).ok).toBe(true);
    });

    it("C3 passes for the live #626 production reply", () => {
      // The regression #625 failed to fix: "I can dig into code and files" contains none of
      // help|assist|support|can do|can help, so the widened allow-list still rejected a good reply.
      expect(evaluateSmokeReply(reply626).ok).toBe(true);
    });

    it("C4 passes for a simple helpful greeting reply", () => {
      expect(evaluateSmokeReply("Hello! I can help you with questions and research.").ok).toBe(true);
    });
  });

  describe("fails for replies that do not claim a capability", () => {
    it("C5 fails for empty, whitespace-only, null and undefined, and never throws", () => {
      for (const reply of ["", "   ", null, undefined]) {
        expect(() => evaluateSmokeReply(reply)).not.toThrow();
        expect(evaluateSmokeReply(reply).ok).toBe(false);
      }
    });

    it("C6 fails for a bare greeting (anti-vacuity guard)", () => {
      // Without this the verdict would pass for any sufficiently long string.
      expect(evaluateSmokeReply("Hi! I'm Eve Agent.").ok).toBe(false);
      expect(evaluateSmokeReply("Hello there!").ok).toBe(false);
      expect(evaluateSmokeReply("Hi! I'm Eve Agent. How are you?").ok).toBe(false);
    });

    it("C7 fails for a refusal, so a decline is never read as a capability claim", () => {
      // "I can't help with that" contains "help", which the old keyword check accepted.
      expect(evaluateSmokeReply("I'm sorry, I can't help with that.").ok).toBe(false);
      expect(evaluateSmokeReply("I am unable to assist with this request.").ok).toBe(false);
    });
  });

  describe("failure messages stay diagnosable", () => {
    it("C8 distinguishes empty, refusal, short and no-capability replies", () => {
      expect(evaluateSmokeReply("").message).toMatch(/nothing/i);
      expect(evaluateSmokeReply("I'm sorry, I can't help with that.").message).toMatch(/declined/i);
      expect(evaluateSmokeReply("Hello there!").message).toMatch(/short/i);
      expect(evaluateSmokeReply("Hi! I'm Eve Agent. How are you today my friend?").message).toMatch(
        /does not say what the agent/i,
      );
    });
  });
});
