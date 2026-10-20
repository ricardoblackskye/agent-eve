/**
 * #414 (epic #403 R2) — the LIST REQUEST carries the order.
 *
 * The route parses search params into `RunListParams`, `validateRunListParams` turns them into the request the store
 * receives, and a refusal there becomes a 400. That is the boundary an operator's sort has to cross, so it is asserted
 * here rather than in the component: a browser-side sort over one fetched page lies about the pages it cannot see.
 */
import { describe, expect, it } from "vitest";

import { RUN_SORT_FIELDS } from "../../agent/lib/dark-factory/run-history-store";
import { validateRunListParams } from "../../agent/lib/dark-factory/run-query";

describe("#414 the list request carries the order", () => {
  it("passes an allowed sort and direction through to the request", () => {
    const result = validateRunListParams({ sort: "createdAt", direction: "asc" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sort).toBe("createdAt");
    expect(result.value.direction).toBe("asc");
  });

  it("leaves the order unset when the client asked for none, so the store's default stands", () => {
    const result = validateRunListParams({});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sort).toBeUndefined();
    expect(result.value.direction).toBeUndefined();
  });

  it("REFUSES an unknown sort column, because ignoring it shows unsorted data", () => {
    const result = validateRunListParams({ sort: "costUsd" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/sort/i);
    expect(result.error).toContain("costUsd");
  });

  it("REFUSES a direction that is neither asc nor desc", () => {
    const result = validateRunListParams({ direction: "sideways" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/direction/i);
  });

  it("allows exactly the field the keyset cursor can serve, and nothing wider", () => {
    expect([...RUN_SORT_FIELDS]).toEqual(["createdAt"]);
  });
});
