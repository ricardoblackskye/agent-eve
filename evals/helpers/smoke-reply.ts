/**
 * Verdict for the `smoke` eval's reply check (#444 -> #624 -> #626).
 *
 * History of this check, because the shape of the fix only makes sense in light of it:
 *
 *   #444  asserted the literal word "you" was echoed. A good answer that answered the question
 *         instead of repeating the pronoun failed in Production.
 *   #624  replaced that with an allow-list of capability words (help|assist|support). The next
 *         sampled greeting said "here's what I can do" and failed.
 *   #625  widened the allow-list to help|assist|support|can do|can help. The next sampled greeting
 *         said "I can dig into code and files" and failed again.
 *
 * Three runs, three wordings, three false negatives. A keyword allow-list cannot work here: the
 * sentence is model-generated and nothing pins its phrasing in agent/instructions.md, so every
 * rewording is a new false negative that only surfaces after a production run. #444's own note said
 * the intent was "a smoke test - boot plus a substantive greeting response - not a vocabulary test".
 *
 * So this asserts the structure of a substantive greeting rather than the words in it:
 *
 *   1. non-empty,
 *   2. long enough to be a real answer rather than a stub,
 *   3. claims an ability in the first person ("I can ...", "I'm able to ..."),
 *   4. is not a refusal.
 *
 * "I can dig into code and files", "here's what I can help with" and "Here's what I can do" all
 * satisfy it. A bare "Hi! I'm Eve Agent." and a decline do not. A reworded greeting cannot fail the
 * gate, which is the whole point.
 */
export type ReplyVerdict = { ok: boolean; message: string };

/**
 * A bare greeting is around 20 characters ("Hi! I'm Eve Agent."). A greeting that actually says what
 * the agent can do runs to 60+. 40 leaves room for a terse-but-real capability sentence while still
 * failing stubs, so length does the anti-vacuity work without needing a word list.
 */
const MIN_SUBSTANTIVE_LENGTH = 40;

/** A decline must never be read as a capability claim - "I can't help with that" contains "help". */
const REFUSAL = /\b(?:I\s+can['’]?t|I\s+cannot|I['’]?m\s+unable|I\s+am\s+unable)\b/i;

/**
 * The structural signal: the reply claims an ability in the first person. This is the shape "says
 * what it can do" takes regardless of wording, and it is deliberately not a list of capabilities.
 */
const FIRST_PERSON_CAPABILITY =
  /\bI\s+(?:can|am\s+able\s+to|['’]?m\s+able\s+to|['’]?m\s+here\s+to)\b/i;

export function evaluateSmokeReply(reply: unknown): ReplyVerdict {
  const text = typeof reply === "string" ? reply.trim() : "";

  if (text.length === 0) {
    return { ok: false, message: "the agent replied with nothing" };
  }

  if (REFUSAL.test(text)) {
    return {
      ok: false,
      message: `the agent declined instead of saying what it can do: ${text.slice(0, 80)}`,
    };
  }

  if (text.length < MIN_SUBSTANTIVE_LENGTH) {
    return {
      ok: false,
      message: `the reply was too short to be a substantive greeting: ${text.slice(0, 80)}`,
    };
  }

  if (!FIRST_PERSON_CAPABILITY.test(text)) {
    return {
      ok: false,
      message: `the reply does not say what the agent can do: ${text.slice(0, 80)}`,
    };
  }

  return { ok: true, message: "the agent replied and said what it can do" };
}
