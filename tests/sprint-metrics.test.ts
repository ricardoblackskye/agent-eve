import { describe, it, expect } from "vitest";
import { computeSprintMetrics } from "../agent/lib/sprint-metrics";
import type { SprintBoardSnapshot } from "../agent/lib/sprint-projects";

const base: SprintBoardSnapshot = {
  projectTitle: "Sprint 9",
  items: [
    {
      number: 1,
      title: "A",
      status: "To Do",
      createdAt: "2026-09-01T00:00:00Z",
      closedAt: null,
    },
    {
      number: 2,
      title: "B",
      status: "In Progress",
      createdAt: "2026-09-01T00:00:00Z",
      closedAt: null,
    },
    {
      number: 3,
      title: "C",
      status: "Done",
      createdAt: "2026-09-01T00:00:00Z",
      closedAt: "2026-09-05T00:00:00Z",
    },
    {
      number: 4,
      title: "D",
      status: "Done",
      createdAt: "2026-09-01T00:00:00Z",
      closedAt: "2026-09-07T00:00:00Z",
    },
    {
      number: 5,
      title: "E",
      status: "Backlog",
      createdAt: "2026-09-01T00:00:00Z",
      closedAt: null,
    },
  ],
};

describe("computeSprintMetrics", () => {
  it("counts to-do / in-progress / done / other", () => {
    const m = computeSprintMetrics(base);
    expect(m.totalItems).toBe(5);
    expect(m.toDo).toBe(1);
    expect(m.inProgress).toBe(1);
    expect(m.done).toBe(2);
    expect(m.other).toBe(1);
    expect(m.totalItems).toBe(m.toDo + m.inProgress + m.done + m.other);
  });

  it("computes cycle time average + median over done items", () => {
    const m = computeSprintMetrics(base);
    expect(m.cycleTimeDays.average).toBeCloseTo(5, 5); // (4 + 6) / 2
    expect(m.cycleTimeDays.median).toBe(5);
  });

  it("returns zero cycle time when nothing is done", () => {
    const m = computeSprintMetrics({
      projectTitle: "X",
      items: [
        {
          number: 1,
          title: "A",
          status: "To Do",
          createdAt: "2026-09-01T00:00:00Z",
          closedAt: null,
        },
      ],
    });
    expect(m.cycleTimeDays.average).toBe(0);
    expect(m.cycleTimeDays.median).toBe(0);
    expect(m.done).toBe(0);
  });
});
