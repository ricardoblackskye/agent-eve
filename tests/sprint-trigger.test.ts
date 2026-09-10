import { describe, it, expect } from "vitest";
import {
  isSprintReportTrigger,
  SPRINT_REPORT_LABEL,
} from "../agent/lib/sprint-trigger";

describe("isSprintReportTrigger", () => {
  it("fires on the sprint-report label", () => {
    expect(
      isSprintReportTrigger({
        action: "labeled",
        label: { name: SPRINT_REPORT_LABEL },
      }),
    ).toBe(true);
  });

  it("is case-insensitive on the label", () => {
    expect(
      isSprintReportTrigger({
        action: "labeled",
        label: { name: "Generate-Sprint-Report" },
      }),
    ).toBe(true);
  });

  it("does not fire on an unrelated label", () => {
    expect(
      isSprintReportTrigger({ action: "labeled", label: { name: "bug" } }),
    ).toBe(false);
  });

  it("does not fire without a labeled action", () => {
    expect(isSprintReportTrigger({ action: "opened" })).toBe(false);
  });

  it("does not fire on closed or deleted issues", () => {
    expect(
      isSprintReportTrigger({
        action: "closed",
        label: { name: SPRINT_REPORT_LABEL },
      }),
    ).toBe(false);
    expect(
      isSprintReportTrigger({
        action: "deleted",
        label: { name: SPRINT_REPORT_LABEL },
      }),
    ).toBe(false);
  });

  it("does not fire on pull requests", () => {
    expect(
      isSprintReportTrigger({
        action: "labeled",
        label: { name: SPRINT_REPORT_LABEL },
        pull_request: { number: 1 },
      }),
    ).toBe(false);
  });
});
