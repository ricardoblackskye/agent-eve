/**
 * OpenRouter contract test (issue #121 / #122; hardened by #472) — the live guard.
 *
 * Proves the resolved model id is a REAL model in OpenRouter's live catalog, not
 * just a string we typed. This is read-only (no API key, no token spend).
 *
 * #472: when the catalog cannot be reached — or answers with something that is
 * not a catalog — this SKIPS with the reason, instead of reporting a pass it did
 * not earn. A FAILURE here now means exactly one thing: the catalog was read, and
 * the model was verified ABSENT from it.
 *
 * It is the reusable pattern for every future model swap: change
 * `model-config.ts`, and this test verifies the id resolves on the provider.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL_ID, FALLBACK_MODEL_ID } from "../agent/model-config";
import { fetchCatalogIds } from "./support/openrouter-catalog";

/** Above the lookup's own deadline, so a skip is reported rather than a timeout. */
const TEST_TIMEOUT_MS = 15_000;

describe("OpenRouter model availability contract", () => {
  it(
    "the primary model id exists in the live OpenRouter catalog",
    async (ctx) => {
      const result = await fetchCatalogIds();
      if (result.kind === "unverifiable") {
        ctx.skip(`cannot verify the live OpenRouter catalog: ${result.reason}`);
        return;
      }
      expect(
        result.ids.has(DEFAULT_MODEL_ID),
        `Verified absent: primary model ${DEFAULT_MODEL_ID} is not in the OpenRouter catalog`,
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the fallback model id exists in the live OpenRouter catalog",
    async (ctx) => {
      const result = await fetchCatalogIds();
      if (result.kind === "unverifiable") {
        ctx.skip(`cannot verify the live OpenRouter catalog: ${result.reason}`);
        return;
      }
      expect(
        result.ids.has(FALLBACK_MODEL_ID),
        `Verified absent: fallback model ${FALLBACK_MODEL_ID} is not in the OpenRouter catalog`,
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
