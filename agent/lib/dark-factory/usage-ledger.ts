/**
 * Dark Factory — canonical LLM usage ledger record (#209, epic #206 R7.3).
 *
 * One provider-neutral shape describing the MEASURED usage of an LLM call or
 * task. The honesty rule (#158) is enforced here, at the single contract point:
 * an unmeasured value is ABSENT, never zero-filled, because "not measured" and
 * "measured zero" are different facts and defaulting one to the other drags
 * every aggregate toward a number nobody observed.
 *
 * Counts only: this module never carries prompt or completion text.
 */

/** Canonical, provider-agnostic usage record for one LLM call or task. */
export interface UsageEvent {
  runId: string;
  /** Product-backlog item the work belongs to, when known. */
  pbiId?: number;
  taskType: string;
  model: string;
  /** Prompt tokens, when the provider reported them. Absent = not measured. */
  tokensIn?: number;
  /** Completion tokens, when the provider reported them. Absent = not measured. */
  tokensOut?: number;
  /** Cost in USD, when it was measured. Absent = not measured. */
  costUsd?: number;
  /** Wall-clock duration in ms, when it was measured. Absent = not measured. */
  durationMs?: number;
  /**
   * Customer tenant this usage is attributed to. Absent means UNASSIGNED — a
   * genuine state for historical rows recorded before attribution existed, and
   * deliberately distinct from "attributed to nobody".
   */
  tenantId?: string;
  /** ISO-8601 timestamp of the call/task. */
  ts: string;
}

export const MAX_USAGE_TOKENS = 2_000_000;
export const MAX_USAGE_COST_USD = 1000;
export const MAX_USAGE_LATENCY_MS = 86_400_000;

/** Longest accepted identifier text (mirrors the run-history contract). */
export const MAX_USAGE_IDENTIFIER_LENGTH = 256;

export class InvalidUsageEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUsageEventError";
  }
}

/**
 * Validate a required identifier.
 *
 * Sanitised at intake so every downstream consumer — stores, loggers, the
 * dashboard — receives a value that cannot carry terminal control characters.
 */
function validateIdentifier(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (
    text === "" ||
    text.length > MAX_USAGE_IDENTIFIER_LENGTH ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(text)
  ) {
    throw new InvalidUsageEventError(
      `Usage event requires "${field}" to be a non-empty string of at most ` +
        `${MAX_USAGE_IDENTIFIER_LENGTH} characters (received ${JSON.stringify(value)}).`,
    );
  }
  return text;
}

/** Validate and normalise the timestamp to a canonical ISO-8601 string. */
function validateTimestamp(value: unknown): string {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new InvalidUsageEventError(
      `Usage event requires "ts" to be an ISO timestamp (received ${JSON.stringify(value)}).`,
    );
  }
  return new Date(parsed).toISOString();
}

/**
 * Validate an OPTIONAL measurement.
 *
 * Absent stays absent: "not measured" and "measured zero" are different facts,
 * so `0` is preserved and `undefined` is omitted. A present value must be a
 * finite number within `[0, max]`, so NaN, Infinity, negatives and absurd
 * magnitudes are refused rather than stored — a nonsense measurement is worse
 * than a missing one, because it silently moves an aggregate.
 */
function assertOptionalMeasurement(
  value: unknown,
  field: string,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > max
  ) {
    throw new InvalidUsageEventError(
      `Usage event requires "${field}" to be a finite number in [0, ${max}] when present ` +
        `(received ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

/** Validate and normalise an incoming usage record. Invalid input THROWS. */
export function toUsageEvent(input: UsageEvent): UsageEvent {
  const runId = validateIdentifier(input.runId, "runId");
  const taskType = validateIdentifier(input.taskType, "taskType");
  const model = validateIdentifier(input.model, "model");
  const ts = validateTimestamp(input.ts);

  const event: UsageEvent = { runId, taskType, model, ts };

  if (input.pbiId !== undefined) {
    if (!Number.isSafeInteger(input.pbiId) || input.pbiId < 1) {
      throw new InvalidUsageEventError(
        `Usage event requires "pbiId" to be a positive safe integer when present ` +
          `(received ${JSON.stringify(input.pbiId)}).`,
      );
    }
    event.pbiId = input.pbiId;
  }

  if (input.tenantId !== undefined) {
    // Validated as an identifier rather than as a UUID: the ledger is
    // provider-neutral and must not depend on the tenant module's id format.
    // The value itself comes from the registry, never from a caller's guess.
    event.tenantId = validateIdentifier(input.tenantId, "tenantId");
  }

  const tokensIn = assertOptionalMeasurement(
    input.tokensIn,
    "tokensIn",
    MAX_USAGE_TOKENS,
  );
  if (tokensIn !== undefined) event.tokensIn = tokensIn;

  const tokensOut = assertOptionalMeasurement(
    input.tokensOut,
    "tokensOut",
    MAX_USAGE_TOKENS,
  );
  if (tokensOut !== undefined) event.tokensOut = tokensOut;

  const costUsd = assertOptionalMeasurement(
    input.costUsd,
    "costUsd",
    MAX_USAGE_COST_USD,
  );
  if (costUsd !== undefined) event.costUsd = costUsd;

  const durationMs = assertOptionalMeasurement(
    input.durationMs,
    "durationMs",
    MAX_USAGE_LATENCY_MS,
  );
  if (durationMs !== undefined) event.durationMs = durationMs;

  return event;
}