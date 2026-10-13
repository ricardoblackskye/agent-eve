import { describe, expect, it } from "vitest";
import * as modelConfig from "../agent/model-config";
import { resolvePrice } from "../agent/lib/dark-factory/cost-budget";

/**
 * #335 — the table must hold a CEILING, and this keeps it honest.
 *
 * OpenRouter routes a model across many upstream providers at different prices (32 for
 * `deepseek/deepseek-v4.1-flash`, spread ~14×) and we pin none of them. Because `admit()` reserves
 * from the price table and `settle()` trues up from the MEASURED cost afterwards, under-reserving is
 * the dangerous direction — so the table must sit at or above the dearest provider.
 *
 * This follows the existing `model-availability.contract.test.ts` pattern exactly: read-only, no API
 * key, no token spend, and it SKIPS cleanly when offline so CI never flakes.
 */
const ENDPOINTS = (id: string) =>
  `https://openrouter.ai/api/v1/models/${id}/endpoints`;
const OFFLINE = process.env.MODEL_CONTRACT_OFFLINE === "1";

async function fetchProviderPrices(
  modelId: string,
): Promise<{ prompt: number; completion: number }[] | null> {
  if (OFFLINE) return null;
  try {
    const res = await fetch(ENDPOINTS(modelId), {
      headers: {
        Accept: "application/json",
        "User-Agent": "agent-eve-price-ceiling-test",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        endpoints?: Array<{
          pricing?: { prompt?: string; completion?: string };
        }>;
      };
    };
    const endpoints = json.data?.endpoints ?? [];
    const prices = endpoints
      .map((e) => ({
        prompt: Number(e.pricing?.prompt),
        completion: Number(e.pricing?.completion),
      }))
      .filter(
        (p) => Number.isFinite(p.prompt) && Number.isFinite(p.completion),
      );
    return prices.length > 0 ? prices : null;
  } catch {
    // Network unavailable — skip rather than fail.
    return null;
  }
}

function declaredModelIds(): string[] {
  return Object.entries(modelConfig)
    .filter(
      ([name, value]) =>
        name.endsWith("_MODEL_ID") && typeof value === "string",
    )
    .map(([, value]) => value as string);
}

describe("#335 price ceiling contract (live OpenRouter catalog)", () => {
  it("holds a ceiling at or above every published provider price", async () => {
    for (const id of declaredModelIds()) {
      const prices = await fetchProviderPrices(id);
      if (prices === null) {
        // Offline / unavailable: skip cleanly, exactly like the model-availability contract test.
        expect(true).toBe(true);
        continue;
      }
      const price = resolvePrice(id);
      expect(price, `${id} has no price in modelPriceTable`).not.toBeNull();
      const maxInputPer1k = Math.max(...prices.map((p) => p.prompt)) * 1000;
      const maxOutputPer1k =
        Math.max(...prices.map((p) => p.completion)) * 1000;
      expect(
        price?.inputUsdPer1k,
        `${id}: table input ${price?.inputUsdPer1k} is below the dearest provider ${maxInputPer1k}`,
      ).toBeGreaterThanOrEqual(maxInputPer1k);
      expect(
        price?.outputUsdPer1k,
        `${id}: table output ${price?.outputUsdPer1k} is below the dearest provider ${maxOutputPer1k}`,
      ).toBeGreaterThanOrEqual(maxOutputPer1k);
    }
  }, 30_000);
});
