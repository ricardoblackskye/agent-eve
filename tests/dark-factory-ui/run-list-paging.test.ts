import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  buildPageRequest,
  pageBounds,
  pageCount,
  runRowId,
} from "../../app/dark-factory/ui/view-model";
import type { RunFilters, TableRow } from "../../app/dark-factory/ui/view-model";

describe("run list paging (#748 task 1)", () => {
  it("defaults to 20 rows and offers 20, 50 and 100", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    expect([...PAGE_SIZE_OPTIONS]).toEqual([20, 50, 100]);
  });

  it("asks the server for the page it is showing", () => {
    const params = buildPageRequest({ statuses: ["running"] }, { page: 1, size: 20 });
    expect(params.get("limit")).toBe("20");
    expect(params.get("offset")).toBe("0");
    expect(params.getAll("status")).toEqual(["running"]);
  });

  it("computes the offset from the page and the size", () => {
    const params = buildPageRequest({}, { page: 3, size: 50 });
    expect(params.get("limit")).toBe("50");
    expect(params.get("offset")).toBe("100");
  });

  it("does not mutate the filters it is given", () => {
    const filters: RunFilters = { statuses: ["failed"] };
    buildPageRequest(filters, { page: 2, size: 20 });
    expect(filters.statuses).toEqual(["failed"]);
    expect(filters.limit).toBeUndefined();
  });

  it("counts pages, including the exact boundary", () => {
    expect(pageCount(0, 20)).toBe(1);
    expect(pageCount(11, 20)).toBe(1);
    expect(pageCount(20, 20)).toBe(1);
    expect(pageCount(21, 20)).toBe(2);
    expect(pageCount(100, 100)).toBe(1);
  });

  it("disables both arrows when there is a single page", () => {
    const bounds = pageBounds(1, 11, 20);
    expect(bounds.canGoBack).toBe(false);
    expect(bounds.canGoForward).toBe(false);
  });

  it("enables the arrows at the ends of a longer list", () => {
    expect(pageBounds(1, 45, 20)).toEqual({ page: 1, canGoBack: false, canGoForward: true });
    expect(pageBounds(3, 45, 20)).toEqual({ page: 3, canGoBack: true, canGoForward: false });
    expect(pageBounds(2, 45, 20)).toEqual({ page: 2, canGoBack: true, canGoForward: true });
  });

  it("clamps a page left beyond the end back to the last page", () => {
    expect(pageBounds(9, 45, 20).page).toBe(3);
  });

  it("identifies a row by its run id", () => {
    const row = { runId: "run-1" } as TableRow;
    expect(runRowId(row)).toBe("run-1");
  });
});
