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
 * Every failure carries a REASON so a skip is informative rather than a silent
 * "2 passed" on a run that verified nothing.
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

/** True when the error looks like an aborted/timed-out request. */
function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /abort|timeout/i.test(error.name) || /abort|timeout/i.test(error.message)
  );
}

function reasonFor(error: unknown, timeoutMs: number): string {
  if (isTimeout(error)) return `timeout after ${timeoutMs}ms`;
  return error instanceof Error ? error.message : String(error);
}

export async function fetchCatalogIds(
  options: CatalogOptions = {},
): Promise<CatalogResult> {
  const {
    url = OPENROUTER_MODELS_URL,
    timeoutMs = DEFAULT_CATALOG_TIMEOUT_MS,
    offline = process.env.MODEL_CONTRACT_OFFLINE === "1",
    fetchImpl = fetch,
  } = options;

  // Explicitly offline: do not touch the network at all.
  if (offline)
    return { kind: "unverifiable", reason: "MODEL_CONTRACT_OFFLINE=1" };

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "agent-eve-contract-test",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { kind: "unverifiable", reason: reasonFor(error, timeoutMs) };
  }

  if (!response.ok) {
    return { kind: "unverifiable", reason: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // An auth wall or captive portal answers 200 with HTML, not JSON.
    return { kind: "unverifiable", reason: "response body was not JSON" };
  }

  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    // A 200 error envelope has no catalog array: we could not ask.
    return {
      kind: "unverifiable",
      reason: "response contained no catalog array",
    };
  }

  const ids = new Set(
    data
      .map((entry) => (entry as { id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === "string"),
  );
  if (ids.size === 0) {
    // An empty catalog is indistinguishable from a broken one. Calling this
    // VERIFIED would let a miss masquerade as a genuine absence.
    return { kind: "unverifiable", reason: "catalog contained no model ids" };
  }

  return { kind: "verified", ids };
}
