import { describe, expect, it } from "vitest";
import { validateRunListParams } from "../../agent/lib/dark-factory/run-query";

// The list is paged, so a filter that only the client applies hides matches on
// pages the client never fetched. These parameters move the filter to the store.

describe("run list filters (#748 task 3)", () => {
  it("carries a search term, trimmed", () => {
    const result = validateRunListParams({ search: "  webfeedpoc  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.search).toBe("webfeedpoc");
  });

  it("refuses a blank search rather than filtering on nothing", () => {
    expect(validateRunListParams({ search: "   " }).ok).toBe(false);
  });

  it("carries a stage, trimmed", () => {
    const result = validateRunListParams({ stage: " terminal " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.stage).toBe("terminal");
  });

  it("refuses a blank stage", () => {
    expect(validateRunListParams({ stage: "" }).ok).toBe(false);
  });

  it("carries a filter alongside a cursor, so a page keeps its filter", () => {
    const result = validateRunListParams({
      search: "webfeedpoc",
      stage: "terminal",
      statuses: ["succeeded"],
      limit: "20",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.search).toBe("webfeedpoc");
    expect(result.request.stage).toBe("terminal");
    expect(result.request.statuses).toEqual(["succeeded"]);
    expect(result.request.limit).toBe(20);
  });
});
