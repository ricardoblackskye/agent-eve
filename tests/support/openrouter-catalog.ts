/**
 * OpenRouter catalog lookup for the live contract tests (#472).
 *
 * A live contract test has three possible outcomes, and they must not be confused:
 *
 * - VERIFIED      the catalog arrived; an absent id is a real regression.
 * - UNVERIFIABLE  we could not ask (offline, HTTP error, a body that is not a
 *                 catalog). The caller must SKIP, never pass and never fail.
 * - absent        only meaningful inside VERIFIED.
 *
 * The previous inline helper returned `null` for every failure, which collapsed
 * "we could not ask" into a single signal and forced callers into a fake pass.
 *
 * TDD RED stub: types and the minimal signature only. No behaviour yet.
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/**
 * Must stay BELOW vitest's default 5000 ms test timeout, otherwise a hanging
 * request outlives the test and the skip branch is never reached.
 */
export const DEFAULT_CATALOG_TIMEOUT_MS = 3000;

export type CatalogResult =
  | { kind: "verified"; ids: Set<string> }
  | { kind: "unverifiable"; reason: string };

export interface CatalogOptions {
  url?: string;
  timeoutMs?: number;
  offline?: boolean;
  fetchImpl?: typeof fetch;
}

export async function fetchCatalogIds(
  _options: CatalogOptions = {},
): Promise<CatalogResult> {
  throw new Error("not implemented");
}
