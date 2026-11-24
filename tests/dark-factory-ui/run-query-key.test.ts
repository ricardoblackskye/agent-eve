import { describe, expect, it } from "vitest";
import { runQueryKey } from "../../app/dark-factory/ui/view-model";

describe("run query key (#748 task 2)", () => {
  it("is the run list, a page, a size and the filters - and nothing else", () => {
    expect(runQueryKey({ statuses: ["failed"] }, { page: 2, size: 20 })).toEqual([
      "dark-factory",
      "runs",
      { page: 2, size: 20, statuses: ["failed"] },
    ]);
  });

  it("is unchanged by a poll: the same inputs give the same key", () => {
    const first = runQueryKey({ statuses: ["failed"] }, { page: 2, size: 20 });
    const second = runQueryKey({ statuses: ["failed"] }, { page: 2, size: 20 });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("changes when the page, the size or the filters change, so paging fetches", () => {
    const base = JSON.stringify(runQueryKey({}, { page: 1, size: 20 }));
    expect(JSON.stringify(runQueryKey({}, { page: 2, size: 20 }))).not.toBe(base);
    expect(JSON.stringify(runQueryKey({}, { page: 1, size: 50 }))).not.toBe(base);
    expect(JSON.stringify(runQueryKey({ statuses: ["failed"] }, { page: 1, size: 20 }))).not.toBe(base);
  });

  it("carries no clock, so a poll cannot invalidate the page in view", () => {
    const key = JSON.stringify(runQueryKey({}, { page: 1, size: 20 }));
    expect(key).not.toMatch(/1[6-9]\d{11}/);
  });
});
