import type { SprintBoardSnapshot } from "./sprint-projects";

export interface CycleTimeStats {
  average: number;
  median: number;
}

export interface SprintMetrics {
  totalItems: number;
  toDo: number;
  /** Work-in-progress: items currently "In Progress". */
  inProgress: number;
  /** Throughput: items currently "Done" this sprint. */
  done: number;
  cycleTimeDays: CycleTimeStats;
}

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

function daysBetween(startIso: string, endIso: string): number {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  return ms / (1000 * 60 * 60 * 24);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute sprint delivery metrics from a board snapshot. Cycle time is the
 * (approximated) elapsed time from an item's `createdAt` to its `closedAt` for
 * items that reached "Done"; items still in flight are excluded from cycle time.
 */
export function computeSprintMetrics(
  snapshot: SprintBoardSnapshot,
): SprintMetrics {
  const items = snapshot.items ?? [];
  let toDo = 0;
  let inProgress = 0;
  let done = 0;
  const cycleTimes: number[] = [];

  for (const item of items) {
    const status = normalizeStatus(item.status);
    if (status === "done") {
      done++;
      if (item.closedAt && item.createdAt) {
        const days = daysBetween(item.createdAt, item.closedAt);
        if (Number.isFinite(days) && days >= 0) cycleTimes.push(days);
      }
    } else if (status === "in progress" || status === "inprogress") {
      inProgress++;
    } else if (status === "to do" || status === "todo") {
      toDo++;
    }
  }

  const average = cycleTimes.length
    ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length
    : 0;

  return {
    totalItems: items.length,
    toDo,
    inProgress,
    done,
    cycleTimeDays: { average, median: median(cycleTimes) },
  };
}
