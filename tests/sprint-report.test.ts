import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../agent/lib/sprint-report";
import type { SprintMetrics } from "../agent/lib/sprint-metrics";

const metrics: SprintMetrics = {
  totalItems: 5,
  toDo: 1,
  inProgress: 2,
  done: 2,
  cycleTimeDays: { average: 3, median: 3 },
};

describe("renderMarkdown", () => {
  it("renders a management-ready markdown report", () => {
    const md = renderMarkdown("Sprint 9", metrics, "2026-09-10");
    expect(md).toContain("# Sprint Metrics Report");
    expect(md).toContain("**Project:** Sprint 9");
    expect(md).toContain("**Generated:** 2026-09-10");
    expect(md).toContain("| Total items | 5 |");
    expect(md).toContain("| To Do | 1 |");
    expect(md).toContain("| In Progress (WIP) | 2 |");
    expect(md).toContain("| Done (throughput) | 2 |");
    expect(md).toContain("| Avg cycle time (days) | 3.0 |");
    expect(md).toContain("| Median cycle time (days) | 3.0 |");
  });
});
