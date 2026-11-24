import { describe, expect, it } from "vitest";
import { runQueryKey } from "../../app/dark-factory/ui/view-model";

describe("run query key (#748 tasks 2 and 4)", () => {
  it("is the run list, a size, an optional cursor and the filters - and nothing else", () => {
    expect(runQueryKey({ statuses: ["failed"] }, { size: 20 })).toEqual([
      "dark-factory",
      "runs",
      { statuses: ["failed"], size: 20 },
    ]);
  });

  it("names the cursor, so a different page is a different key", () => {
    const first = runQueryKey({}, { size: 20 });
    const second = runQueryKey({}, { size: 20, cursor: "tok-1" });
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
    expect(JSON.stringify(second)).toContain("tok-1");
  });

  it("is unchanged by a poll: the same inputs give the same key", () => {
    const first = runQueryKey({ statuses: ["failed"] }, { size: 20, cursor: "tok-1" });
    const second = runQueryKey({ statuses: ["failed"] }, { size: 20, cursor: "tok-1" });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("changes when the size or the filters change", () => {
    const base = JSON.stringify(runQueryKey({}, { size: 20 }));
    expect(JSON.stringify(runQueryKey({}, { size: 50 }))).not.toBe(base);
    expect(JSON.stringify(runQueryKey({ statuses: ["failed"] }, { size: 20 }))).not.toBe(base);
  });

  it("carries no clock, so a poll cannot invalidate the page in view", () => {
    expect(JSON.stringify(runQueryKey({}, { size: 20 }))).not.toMatch(/1[6-9]\d{11}/);
  });
});
