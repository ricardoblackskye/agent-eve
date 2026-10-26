/**
 * #472 — the OpenRouter catalog lookup must distinguish
 * "we could not verify" from "verified absent", and must never fake-pass.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CATALOG_TIMEOUT_MS,
  fetchCatalogIds,
} from "./support/openrouter-catalog";

const catalogBody = (ids: string[]) => ({ data: ids.map((id) => ({ id })) });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const asFetch = (impl: unknown) => impl as typeof fetch;

describe("#472 catalog lookup — cannot verify vs verified absent", () => {
  it("reports unverifiable, and never touches the network, when offline", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchCatalogIds({ offline: true, fetchImpl: asFetch(fetchImpl) });

    expect(result.kind).toBe("unverifiable");
    if (result.kind === "unverifiable") expect(result.reason).toMatch(/offline/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports unverifiable, naming the status, when the response is not ok", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "nope" }, 403));
    const result = await fetchCatalogIds({ fetchImpl: asFetch(fetchImpl) });

    expect(result.kind).toBe("unverifiable");
    if (result.kind === "unverifiable") expect(result.reason).toMatch(/403/);
  });

  it("reports unverifiable when a 200 carries no catalog array (auth wall, error envelope)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "please sign in" }));
    const result = await fetchCatalogIds({ fetchImpl: asFetch(fetchImpl) });

    expect(result.kind).toBe("unverifiable");
    if (result.kind === "unverifiable") expect(result.reason).toMatch(/catalog/i);
  });

  it("reports unverifiable when an empty catalog arrives, rather than an empty verified set", async () => {
    // The old helper turned this into an empty Set, so a miss looked like a
    // verified absence and the model was wrongly reported as missing.
    const fetchImpl = vi.fn(async () => jsonResponse(catalogBody([])));
    const result = await fetchCatalogIds({ fetchImpl: asFetch(fetchImpl) });

    expect(result.kind).toBe("unverifiable");
  });

  it("reports unverifiable when the body is not JSON at all", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>sign in</html>", { status: 200 }),
    );
    const result = await fetchCatalogIds({ fetchImpl: asFetch(fetchImpl) });

    expect(result.kind).toBe("unverifiable");
  });

  it("reports verified with a real id set when an actual catalog arrives", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(catalogBody(["a/b", "c/d"])));
    const result = await fetchCatalogIds({ fetchImpl: asFetch(fetchImpl) });

    expect(result.kind).toBe("verified");
    if (result.kind === "verified") {
      expect(result.ids.has("a/b")).toBe(true);
      // A miss inside a VERIFIED result is a genuine absence, not an outage.
      expect(result.ids.has("missing/model")).toBe(false);
    }
  });

  it("resolves to unverifiable when the network hangs, well inside the test timeout", async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    const started = Date.now();
    const result = await fetchCatalogIds({
      timeoutMs: 50,
      fetchImpl: asFetch(fetchImpl),
    });
    const elapsed = Date.now() - started;

    expect(result.kind).toBe("unverifiable");
    if (result.kind === "unverifiable") expect(result.reason).toMatch(/timeout|abort/i);
    // The whole point: the deadline fires long before the runner's own timeout.
    expect(elapsed).toBeLessThan(2000);
  }, 15_000);

  it("ships a default timeout below the runner's 5s test timeout", () => {
    expect(DEFAULT_CATALOG_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_CATALOG_TIMEOUT_MS).toBeLessThan(5000);
  });
});
