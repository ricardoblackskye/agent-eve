import { describe, expect, it } from "vitest";
import { formatDateTime } from "../../app/dark-factory/ui/format";
import { toTableRows } from "../../app/dark-factory/ui/view-model";

type Runs = Parameters<typeof toTableRows>[0];
type Run = Runs[number];

const RUN = {
  runId: "df-1a2b",
  repo: "owner/repo",
  issue: 198,
  status: "succeeded",
  stage: "terminal",
  createdAt: "2026-09-25T09:14:00.000Z",
  updatedAt: "2026-09-25T09:28:02.000Z",
  startedAt: "2026-09-25T09:14:00.000Z",
  completedAt: "2026-09-25T09:28:02.000Z",
  attemptCount: 3,
  reviewCount: 2,
  iterationCount: 3,
  fixCycleCount: 1,
  latencyMs: 1917,
  costUsd: 0.42,
  prUrl: "https://github.com/owner/repo/pull/202",
} as unknown as Run;

describe("run row date and time (#748 task 3)", () => {
  it("puts the date and the time on the row as one field", () => {
    const updatedAt = "2026-11-01T14:32:00.000Z";
    const rows = toTableRows([{ ...RUN, updatedAt } as Run], new Date(updatedAt));
    expect(rows[0].updatedAtLabel).toBe(formatDateTime(updatedAt));
  });

  it("reads in the agreed shape", () => {
    const updatedAt = "2026-11-01T14:32:00.000Z";
    const rows = toTableRows([{ ...RUN, updatedAt } as Run], new Date(updatedAt));
    expect(rows[0].updatedAtLabel).toMatch(/^\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}$/);
  });

  it("shows the reader's own clock, built here from local components", () => {
    // Local on both sides, so this holds wherever the suite runs.
    const updatedAt = new Date(2026, 10, 1, 14, 32).toISOString();
    const rows = toTableRows([{ ...RUN, updatedAt } as Run], new Date(2026, 10, 1, 15, 32));
    expect(rows[0].updatedAtLabel).toBe("01 Nov 2026, 14:32");
  });

  it("keeps the relative label, so the row gains a field rather than swapping one", () => {
    const updatedAt = new Date(2026, 10, 1, 14, 32).toISOString();
    const rows = toTableRows([{ ...RUN, updatedAt } as Run], new Date(2026, 10, 1, 15, 32));
    expect(rows[0].updatedLabel).toBeTruthy();
  });
});
