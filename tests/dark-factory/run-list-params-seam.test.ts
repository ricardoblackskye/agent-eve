import { describe, expect, it } from "vitest";

import { queryRunListFromParams } from "../../agent/lib/dark-factory/run-query";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

/**
 * #748 task 3, the seam that was missing.
 *
 * The route was tested for the params it parses, and the store was tested for the clause it builds,
 * and nothing asserted the wire between them. It was cut: the filters never reached the store, so a
 * search that matched nothing returned every row. These cases read the options the store is handed.
 */
function captureOptions() {
  const seen: Array<Record<string, unknown>> = [];
  const store = {
    listRuns: async (options: Record<string, unknown>) => {
      seen.push(options);
      return { ok: true, value: { items: [], nextCursor: null } };
    },
  } as unknown as RunHistoryStore;
  return { store, seen };
}

describe("the run list params reach the store (#748 task 3)", () => {
  it("passes a search term through to the store", async () => {
    const { store, seen } = captureOptions();
    await queryRunListFromParams(
      store,
      { search: "zzz-no-such-run-zzz" },
      { role: "operator" },
    );
    expect(seen[0]?.search).toBe("zzz-no-such-run-zzz");
  });

  it("passes a stage through to the store", async () => {
    const { store, seen } = captureOptions();
    await queryRunListFromParams(store, { stage: "review" }, { role: "operator" });
    expect(seen[0]?.stage).toBe("review");
  });

  it("leaves both unset when neither was asked for", async () => {
    const { store, seen } = captureOptions();
    await queryRunListFromParams(store, {}, { role: "operator" });
    expect(seen[0]?.search).toBeUndefined();
    expect(seen[0]?.stage).toBeUndefined();
  });
});
