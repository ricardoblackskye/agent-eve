/**
 * PR-reviewer usage-ledger integration (#209).
 *
 * Keeps the recording wiring out of the 650-line reviewer script so it can be
 * unit tested, the same split used for the cost-budget wiring.
 *
 * Recording is OPT-IN and BEST-EFFORT: a ledger outage — or a malformed event —
 * must never fail the review, because usage bookkeeping is telemetry and CI is
 * the thing that actually matters here. Every suppressed failure is logged, so
 * "best-effort" never means "silently broken".
 */

import { recordSafely, BufferedUsageRecorder, type UsageStore } from "../agent/lib/dark-factory/usage-store";
import {
  createUsageStore,
  isUsageRecordingConfigured,
} from "../agent/lib/dark-factory/usage-store-provider";
import type { UsageEvent } from "../agent/lib/dark-factory/usage-ledger";

export interface OpenRouterUsage {
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export interface ReviewUsageInput {
  runId: string;
  pbiId?: number;
  model: string;
  /** The raw provider response body; its `usage` block is read when present. */
  data?: unknown;
  durationMs?: number;
  ts?: string;
}

/** A present measurement must be a finite, non-negative number. */
function measurement(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Read the provider `usage` block.
 *
 * Every field is OPTIONAL: a provider that reports nothing yields `{}` rather
 * than zeros, so an unmeasured call never drags an aggregate toward 0.
 */
export function extractOpenRouterUsage(data: unknown): OpenRouterUsage {
  const usage = (data as { usage?: Record<string, unknown> } | null | undefined)
    ?.usage;
  if (!usage) return {};

  const result: OpenRouterUsage = {};
  const tokensIn = measurement(usage.prompt_tokens);
  const tokensOut = measurement(usage.completion_tokens);
  // OpenRouter reports USD cost on `usage.cost` (or `usage.total_cost`).
  const costUsd = measurement(usage.cost ?? usage.total_cost);
  if (tokensIn !== undefined) result.tokensIn = tokensIn;
  if (tokensOut !== undefined) result.tokensOut = tokensOut;
  if (costUsd !== undefined) result.costUsd = costUsd;
  return result;
}

/**
 * Returns a buffered store only when recording is configured; else `null`.
 *
 * The buffer is what makes the "a ledger outage must not fail the task" rule
 * hold at the call site: a failed write is retained for a later flush instead of
 * surfacing to the reviewer.
 */
export function createReviewUsageStore(
  env: Record<string, string | undefined> = process.env,
): UsageStore | null {
  if (!isUsageRecordingConfigured(env)) return null;
  return new BufferedUsageRecorder(createUsageStore(env));
}

/**
 * Record one review call. Resolves `false` instead of throwing on ANY failure,
 * including a malformed event, because telemetry must never fail CI.
 */
export async function recordReviewUsage(
  store: UsageStore | null,
  input: ReviewUsageInput,
): Promise<boolean> {
  if (!store) return false;

  try {
    const measured = extractOpenRouterUsage(input.data);
    const event: UsageEvent = {
      runId: input.runId,
      ...(input.pbiId !== undefined ? { pbiId: input.pbiId } : {}),
      taskType: "pr-review",
      model: input.model,
      ...(measured.tokensIn !== undefined ? { tokensIn: measured.tokensIn } : {}),
      ...(measured.tokensOut !== undefined
        ? { tokensOut: measured.tokensOut }
        : {}),
      ...(measured.costUsd !== undefined ? { costUsd: measured.costUsd } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ts: input.ts ?? new Date().toISOString(),
    };

    const result = await recordSafely(store, event);
    if (!result.ok) {
      console.warn(
        `[usage] review usage was not recorded: ${result.error ?? "unknown error"}`,
      );
    }
    return result.ok;
  } catch (error) {
    console.warn(
      `[usage] review usage event was rejected and not recorded: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}