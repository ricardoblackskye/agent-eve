/**
 * Dark Factory — the pre-call reservation's INPUT bound (#637).
 *
 * `admit()` reserves a bounded cost against the category's cap before the provider call,
 * and refuses the call when `spent + reserved + estimate > cap`. That estimate used to be
 * `inputTokens x input price + output bound x output price`, with `inputTokens` set to the
 * model's WHOLE context window (1_048_576 for the orchestrator). On
 * `deepseek/deepseek-v4.1-flash` that reserved **$1.2156 for every turn**, so once a
 * period's headroom fell below $1.22 — `spent > $78.78` of an $80 cap — every turn was
 * refused before the provider call, which eve reports as `MODEL_SELECTION_FAILED`. The
 * reservation now tracks the CALL instead.
 *
 * This module is deliberately PESSIMISTIC and stays an UPPER bound (ADR 0027:
 * over-reserving is transient, under-reserving is not):
 *
 * - `CHARS_PER_TOKEN` is below the usual 4, because code and JSON cost more tokens per
 *   character than prose.
 * - the system prompt, instructions and tool schemas the provider bills are NOT in
 *   `ctx.messages`, so a fixed overhead is added for them and can be corrected by an operator.
 * - an attachment part carries no text to count, so it gets a flat allowance.
 * - an unreadable conversation reserves the FULL context window — the previous behaviour,
 *   kept as the fail-closed answer rather than a cheap one.
 *
 * The result is only ever used to reserve: settlement reconciles against what the provider
 * actually reports.
 */

/**
 * Characters per token assumed for text. Below the customary 4 on purpose: under-counting
 * tokens under-reserves, which is the direction that costs money.
 */
export const CHARS_PER_TOKEN = 3;

/** Flat allowance for one attachment part, whose pixels never appear in the text. */
export const ATTACHMENT_TOKENS = 1_000;

/**
 * Allowance for what `ctx.messages` does not contain but the provider still bills: the
 * system prompt, the agent instructions, and the tool schemas.
 */
export const DEFAULT_PROMPT_OVERHEAD_TOKENS = 8_000;

/** Operator override for {@link DEFAULT_PROMPT_OVERHEAD_TOKENS}. */
export const PROMPT_OVERHEAD_ENV = "DF_COST_PROMPT_OVERHEAD_TOKENS";

function resolveOverheadTokens(env: Record<string, string | undefined> | undefined): number {
  const raw = env?.[PROMPT_OVERHEAD_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_PROMPT_OVERHEAD_TOKENS;
  const parsed = Number(raw);
  // A nonsense override must not become a small reservation: fall back to the default.
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PROMPT_OVERHEAD_TOKENS;
  return parsed;
}

interface MessageSize {
  chars: number;
  attachments: number;
}

/**
 * Measure `ctx.messages`. Returns `null` when it is not a readable array, which the caller
 * turns into the fail-closed answer.
 *
 * Shape follows eve's resolver context: each entry has `role` and a `content` that is either
 * a string or an array of parts (`{ type: "text", text }`, `{ type: "image" }`,
 * `{ type: "file", mediaType }`).
 */
function measureMessages(messages: unknown): MessageSize | null {
  if (!Array.isArray(messages)) return null;
  const size: MessageSize = { chars: 0, attachments: 0 };
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      size.chars += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const { type, text } = part as { type?: unknown; text?: unknown };
      if (typeof text === "string") {
        size.chars += text.length;
      } else if (type === "image" || type === "file") {
        size.attachments += 1;
      }
    }
  }
  return size;
}

export interface ReservationInputTokensInput {
  /** eve's `ctx.messages`, or anything else — an unreadable value reserves the window. */
  messages?: unknown;
  /** The model's context window: never reserve more than the model can accept. */
  contextWindowTokens: number;
  env?: Record<string, string | undefined>;
}

/**
 * The input bound to reserve for one call, clamped to the model's context window.
 *
 * Unreadable conversation, or a window that is not a positive number, gives the window
 * itself — the worst case, never a free pass.
 */
export function reservationInputTokens(input: ReservationInputTokensInput): number {
  const window = input.contextWindowTokens;
  if (!Number.isFinite(window) || window <= 0) return 0;

  const size = measureMessages(input.messages);
  // Fail-closed: the prompt could not be read, so reserve what it COULD have been.
  if (size === null) return window;

  const estimated =
    Math.ceil(size.chars / CHARS_PER_TOKEN) +
    size.attachments * ATTACHMENT_TOKENS +
    resolveOverheadTokens(input.env);

  if (!Number.isFinite(estimated) || estimated <= 0) return window;
  return Math.min(window, estimated);
}
