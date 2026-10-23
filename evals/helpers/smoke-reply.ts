/**
 * Verdict for the `smoke` eval's reply check (#444).
 *
 * The eval asserted the literal string "you" was present in the reply. The prompt contains that
 * word and the assertion expected it echoed, so a good answer that answered the question instead
 * of repeating the pronoun failed - which is what happened in Production:
 *
 *   "Hi! I'm Eve Agent - here's what I can actually help with: ..." did not include "you".
 *
 * This asserts the behaviour that check was a proxy for: the agent replied, and said what it can
 * help with. It is a smoke test - boot plus a substantive greeting response - not a vocabulary test.
 */
export type ReplyVerdict = { ok: boolean; message: string };

const SAYS_WHAT_IT_CAN_DO = /help|assist|support/i;

export function evaluateSmokeReply(reply: unknown): ReplyVerdict {
  const text = typeof reply === "string" ? reply.trim() : "";

  if (text.length === 0) {
    return { ok: false, message: "the agent replied with nothing" };
  }

  if (!SAYS_WHAT_IT_CAN_DO.test(text)) {
    return {
      ok: false,
      message: `the reply does not say what the agent can help with: ${text.slice(0, 80)}`,
    };
  }

  return { ok: true, message: "the agent replied and said what it can help with" };
}
