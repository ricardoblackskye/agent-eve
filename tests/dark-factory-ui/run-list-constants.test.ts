import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  runRowId,
} from "../../app/dark-factory/ui/view-model";

// The survivors of task 1, whose paging helpers retired when the list moved to a
// cursor. These three are still used: the size the list opens with, the sizes it
// offers, and the row key the table needs.
describe("run list constants and row key (#748)", () => {
  it("opens at twenty rows", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
  });

  it("offers twenty, fifty and one hundred", () => {
    expect([...PAGE_SIZE_OPTIONS]).toEqual([20, 50, 100]);
  });

  it("keys a row by its run id", () => {
    expect(runRowId({ runId: "run-1" } as Parameters<typeof runRowId>[0])).toBe("run-1");
  });
});
