import { describe, it, expect } from "vitest";
import { computeSprintMetrics } from "../agent/lib/sprint-metrics";
import type { SprintBoardSnapshot } from "../agent/lib/sprint-projects";

const snapshot: SprintBoardSnapshot = {
  projectTitle: "Sprint 9",
  items: [
    {
      number: 1,
      title: "a",
      status: "Done",
      createdAt: "2026-09-01T00:00:00Z",
      closedAt: "2026-09-05T00:00:00Z", // 4 days
    },
    {
      number: 2,
      title: "b",
      status: "Done",
      createdAt: "2026-09-01T00:00:00Z",
      closedAt: "2026-09-03T00:00:00Z", // 2 days
    },
    {
      number: 3,
      title: "c",
      status: "In Progress",
      createdAt: "2026-09-02T00:00:00Z",
      closedAt: null,
    },
    {
      number: 4,
      title: "d",
      status: "In Progress",
      createdAt: "2026-09-03T00:00:00Z",
      closedAt: null,
    },
    {
      number: 5,
      title: "e",
      status: "To Do",
      createdAt: "2026-09-04T00:00:00Z",
      closedAt: null,
    },
  ],
};

describe("computeSprintMetrics", () => {
  it("counts totals, WIP and throughput", () => {
    const m = computeSprintMetrics(snapshot);
    expect(m.totalItems).toBe(5);
    expect(m.toDo).toBe(1);
    expect(m.inProgress).toBe(2); // WIP
    expect(m.done).toBe(2); // throughput
  });

  it("computes cycle time average and median in days", () => {
    const m = computeSprintMetrics(snapshot);
    expect(m.cycleTimeDays.average).toBeCloseTo(3); // (4 + 2) / 2
    expect(m.cycleTimeDays.median).toBeCloseTo(3); // [2, 4]
  });

  it("is case-insensitive on status column names", () => {
    const m = computeSprintMetrics({
      projectTitle: "x",
      items: [
        {
          number: 1,
          title: "a",
          status: "done",
          createdAt: "2026-09-01T00:00:00Z",
          closedAt: "2026-09-03T00:00:00Z",
        },
        {
          number: 2,
          title: "b",
          status: "IN PROGRESS",
          createdAt: "2026-09-01T00:00:00Z",
          closedAt: null,
        },
      ],
    });
    expect(m.done).toBe(1);
    expect(m.inProgress).toBe(1);
  });

  it("returns zeros for an empty board (no NaN)", () => {
    const m = computeSprintMetrics({ projectTitle: "x", items: [] });
    expect(m.totalItems).toBe(0);
    expect(m.cycleTimeDays.average).toBe(0);
    expect(m.cycleTimeDays.median).toBe(0);
  });
});
