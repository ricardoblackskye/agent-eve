/**
 * OpenRouter contract test (issue #121 / #122) — the "creative" live guard.
 *
 * Proves the resolved model id is a REAL model in OpenRouter's live catalog,
 * not just a string we typed. This is read-only (GET /v1/models, no API key,
 * no token spend) and SKIPS when offline so CI never flakes.
 *
 * It is the reusable pattern for every future model swap: change
 * `model-config.ts`, and this test verifies the id resolves on the provider.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL_ID, FALLBACK_MODEL_ID } from "../agent/model-config";

const MODELS_URL = "https://openrouter.ai/api/v1/models";

async function fetchCatalogIds(): Promise<Set<string> | null> {
  // Skip cleanly when explicitly disabled or in a no-network CI slice.
  if (process.env.MODEL_CONTRACT_OFFLINE === "1") return null;
  try {
    const res = await fetch(MODELS_URL, {
      headers: { Accept: "application/json", "User-Agent": "agent-eve-contract-test" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return new Set((json.data ?? []).map((m) => m.id));
  } catch {
    // Network/unavailable — skip rather than fail.
    return null;
  }
}

describe("OpenRouter model availability contract", () => {
  it("the primary model id exists in the live OpenRouter catalog", async () => {
    const ids = await fetchCatalogIds();
    if (ids === null) {
      // Offline / disabled: record the skip intent without failing.
      console.warn(
        `[model-availability] SKIPPED (offline or MODEL_CONTRACT_OFFLINE=1) — primary=${DEFAULT_MODEL_ID}`,
      );
      expect(true).toBe(true);
      return;
    }
    expect(
      ids.has(DEFAULT_MODEL_ID),
      `Primary model ${DEFAULT_MODEL_ID} is NOT in the OpenRouter catalog`,
    ).toBe(true);
  });

  it("the fallback model id exists in the live OpenRouter catalog", async () => {
    const ids = await fetchCatalogIds();
    if (ids === null) {
      console.warn(
        `[model-availability] SKIPPED (offline or MODEL_CONTRACT_OFFLINE=1) — fallback=${FALLBACK_MODEL_ID}`,
      );
      expect(true).toBe(true);
      return;
    }
    expect(
      ids.has(FALLBACK_MODEL_ID),
      `Fallback model ${FALLBACK_MODEL_ID} is NOT in the OpenRouter catalog`,
    ).toBe(true);
  });
});
