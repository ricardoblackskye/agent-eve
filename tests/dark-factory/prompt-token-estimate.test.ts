import { describe, expect, it } from "vitest";

import {
  CHARS_PER_TOKEN,
  DEFAULT_PROMPT_OVERHEAD_TOKENS,
  PROMPT_OVERHEAD_ENV,
  reservationInputTokens,
} from "../../agent/lib/dark-factory/prompt-token-estimate";

/**
 * #637 — the pre-call reservation must track the CALL, not the model's window.
 *
 * `admit()` refuses when `spent + reserved + estimate > cap`, and the estimate was
 * `inputTokens x input price + 8_000 x output price` where `inputTokens` was the whole
 * context window (`ORCHESTRATOR_CONTEXT_WINDOW_TOKENS` = 1_048_576). On
 * `deepseek/deepseek-v4.1-flash` that reserved **$1.2156 for every turn**, so once a
 * period's headroom fell below $1.22 — i.e. `spent > $78.78` of an $80 cap — every turn was
 * refused before the provider call. Eve surfaces that as `MODEL_SELECTION_FAILED`.
 *
 * The bound must stay an UPPER bound (ADR 0027: under-reserving is the failure that
 * matters), so this estimator is deliberately pessimistic, and it falls back to the FULL
 * context window whenever it cannot read the conversation.
 */

const WINDOW = 1_048_576;

/** A message shaped like eve's `ctx.messages` entries. */
const userMessage = (text: string) => ({ role: "user", content: text });

describe("#637 the reservation is sized from the conversation", () => {
  it("falls back to the whole window when the conversation cannot be read", () => {
    // Fail-closed in the SAFE direction: an unreadable prompt reserves the worst case,
    // which is exactly the behaviour that existed before this change.
    for (const unreadable of [undefined, null, "not-an-array", 42, {}]) {
      expect(reservationInputTokens({ messages: unreadable, contextWindowTokens: WINDOW })).toBe(
        WINDOW,
      );
    }
  });

  it("reserves far less than the window for a small conversation (the defect)", () => {
    // The reproduction turn was ~3.5k real tokens. Reserving $1.2156 for it is what pinned
    // the usable ceiling at ~$78.78 and broke the production evals.
    const reserved = reservationInputTokens({
      messages: [userMessage("ping")],
      contextWindowTokens: WINDOW,
    });
    expect(reserved).toBeLessThan(WINDOW / 100);
    expect(reserved).toBeGreaterThan(0);
  });

  it("grows with the conversation, so the bound tracks the call", () => {
    const small = reservationInputTokens({
      messages: [userMessage("hello")],
      contextWindowTokens: WINDOW,
    });
    const large = reservationInputTokens({
      messages: [userMessage("hello"), userMessage("x".repeat(30_000))],
      contextWindowTokens: WINDOW,
    });
    expect(large).toBeGreaterThan(small);
  });

  it("never exceeds the context window, however large the conversation", () => {
    const reserved = reservationInputTokens({
      messages: [userMessage("x".repeat(50_000_000))],
      contextWindowTokens: WINDOW,
    });
    expect(reserved).toBeLessThanOrEqual(WINDOW);
  });

  it("carries an overhead for what ctx.messages does not contain", () => {
    // The provider also bills the system prompt, instructions and tool schemas, and those
    // are NOT in ctx.messages. A bound that ignored them could under-reserve.
    const reserved = reservationInputTokens({ messages: [], contextWindowTokens: WINDOW });
    expect(reserved).toBeGreaterThanOrEqual(DEFAULT_PROMPT_OVERHEAD_TOKENS);
  });

  it("honours an operator override for that overhead", () => {
    const reserved = reservationInputTokens({
      messages: [],
      contextWindowTokens: WINDOW,
      env: { [PROMPT_OVERHEAD_ENV]: "2000" },
    });
    expect(reserved).toBe(2_000);
  });

  it("fails closed on a nonsense override rather than reserving nothing", () => {
    for (const bad of ["", "abc", "-5", "0"]) {
      const reserved = reservationInputTokens({
        messages: [],
        contextWindowTokens: WINDOW,
        env: { [PROMPT_OVERHEAD_ENV]: bad },
      });
      expect(reserved, `override '${bad}'`).toBeGreaterThanOrEqual(DEFAULT_PROMPT_OVERHEAD_TOKENS);
    }
  });

  it("counts string content and text parts", () => {
    const asStrings = reservationInputTokens({
      messages: [userMessage("x".repeat(9_000))],
      contextWindowTokens: WINDOW,
    });
    const asParts = reservationInputTokens({
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(9_000) }] }],
      contextWindowTokens: WINDOW,
    });
    expect(asParts).toBe(asStrings);
    expect(asStrings).toBeGreaterThanOrEqual(9_000 / CHARS_PER_TOKEN);
  });

  it("allows for an attachment part, which carries no text to count", () => {
    const withFile = reservationInputTokens({
      messages: [{ role: "user", content: [{ type: "file", mediaType: "image/png" }] }],
      contextWindowTokens: WINDOW,
    });
    const withoutFile = reservationInputTokens({ messages: [], contextWindowTokens: WINDOW });
    expect(withFile).toBeGreaterThan(withoutFile);
  });
});
