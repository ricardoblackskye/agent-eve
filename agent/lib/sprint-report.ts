import type { SprintMetrics } from "./sprint-metrics";

/**
 * Render a senior-management-ready markdown sprint report from the computed
 * metrics. Pure — no I/O — so it is trivially unit-testable.
 */
export function renderMarkdown(
  projectTitle: string,
  metrics: SprintMetrics,
  generatedAt: string,
): string {
  const rows = [
    ["Total items", String(metrics.totalItems)],
    ["To Do", String(metrics.toDo)],
    ["In Progress (WIP)", String(metrics.inProgress)],
    ["Done (throughput)", String(metrics.done)],
    ["Avg cycle time (days)", metrics.cycleTimeDays.average.toFixed(1)],
    ["Median cycle time (days)", metrics.cycleTimeDays.median.toFixed(1)],
  ];

  const table = rows
    .map(([label, value]) => `| ${label} | ${value} |`)
    .join("\n");

  return [
    "# Sprint Metrics Report",
    "",
    `**Project:** ${projectTitle}`,
    `**Generated:** ${generatedAt}`,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    table,
    "",
  ].join("\n");
}
