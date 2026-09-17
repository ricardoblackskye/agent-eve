/**
 * Model benchmark helpers (issue #121 / #122) — the L1 (latency) and L2
 * (quality) verification foundation.
 *
 * Split into two layers so the *policy* is unit-tested offline and only the
 * live measurement needs a key + network:
 *  - pure functions: `assertLatencyWithinBudget`, `gradeStoryQuality`
 *  - integration: `measureLatency` (live OpenRouter streaming call)
 *
 * All live callers MUST skip when no OPENROUTER_API_KEY / offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface LatencyBudget {
  /** Absolute hard ceiling (ms). A real guard against gross regression. */
  ceilingMs: number;
  /**
   * Recorded live baseline (ms). When null, only the ceiling applies.
   * Re-measure live with MODEL_BENCH_RECORD=1 and commit the value.
   */
  baselineMs: number | null;
  /** Tolerance multiplier on the baseline (e.g. 1.5 = allow +50%). */
  tolerance: number;
}

export interface LatencyResult {
  ttftMs: number;
  totalMs: number;
}

export interface BudgetViolation {
  metric: "ttftMs" | "totalMs";
  value: number;
  limit: number;
  kind: "ceiling" | "baseline";
}

/**
 * Pure: decide whether a measured latency violates the budget.
 * Returns an empty array when within budget (pass).
 */
export function assertLatencyWithinBudget(
  measured: LatencyResult,
  budget: LatencyBudget,
): BudgetViolation[] {
  const violations: BudgetViolation[] = [];

  // Hard ceiling always applies.
  if (measured.ttftMs > budget.ceilingMs) {
    violations.push({
      metric: "ttftMs",
      value: measured.ttftMs,
      limit: budget.ceilingMs,
      kind: "ceiling",
    });
  }
  if (measured.totalMs > budget.ceilingMs) {
    violations.push({
      metric: "totalMs",
      value: measured.totalMs,
      limit: budget.ceilingMs,
      kind: "ceiling",
    });
  }

  // Baseline ratio only when a real baseline exists.
  if (budget.baselineMs != null) {
    const limit = budget.baselineMs * budget.tolerance;
    if (measured.ttftMs > limit) {
      violations.push({
        metric: "ttftMs",
        value: measured.ttftMs,
        limit,
        kind: "baseline",
      });
    }
    if (measured.totalMs > limit) {
      violations.push({
        metric: "totalMs",
        value: measured.totalMs,
        limit,
        kind: "baseline",
      });
    }
  }

  return violations;
}

// The pure quality gate moved to `agent/lib/quality-gate.ts` so PRODUCTION code
// (the #146 self-improvement controller's MEASURE step) can reuse the SAME gate
// without importing the test tree into the app bundle. Imported for local use
// AND re-exported, so existing callers — and the offline unit tests in
// `tests/model-bench-helpers.test.ts` — keep working unchanged.
import {
  gradeStoryQuality,
  type QualityGate,
  type QualityResult,
} from "../../agent/lib/quality-gate";

export { gradeStoryQuality };
export type { QualityGate, QualityResult };

/**
 * Integration: measure latency of a single chat completion via OpenRouter
 * streaming. Returns TTFT (time to first content token) and total time.
 * Throws on transport error so the caller can decide to skip.
 */
export async function measureLatency(opts: {
  modelId: string;
  apiKey: string;
  prompt: string;
  baseURL?: string;
}): Promise<LatencyResult> {
  const baseURL = opts.baseURL ?? "https://openrouter.ai/api/v1";
  const start = Date.now();
  let ttftMs = -1;

  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.modelId,
      stream: true,
      messages: [{ role: "user", content: opts.prompt }],
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`OpenRouter returned ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE lines: "data: {json}" or "data: [DONE]"
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const token = json.choices?.[0]?.delta?.content;
        if (token && ttftMs < 0) {
          ttftMs = Date.now() - start;
        }
      } catch {
        // ignore partial/keep-alive lines
      }
    }
  }

  return { ttftMs: ttftMs < 0 ? 0 : ttftMs, totalMs: Date.now() - start };
}

/** Load the committed benchmark baseline (latency ceiling + quality gate). */
export function loadModelBaseline(): {
  latency: LatencyBudget;
  quality: QualityGate;
  gradedPrompt: string;
} {
  const raw = readFileSync(
    join(process.cwd(), "tests", "fixtures", "model-baseline.json"),
    "utf8",
  );
  return JSON.parse(raw);
}
