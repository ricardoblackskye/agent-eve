import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
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
    ["Other / unrecognized status", String(metrics.other)],
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

/**
 * Render the same sprint metrics as a PDF (A4) suitable for senior-management
 * presentation. Uses pdf-lib (pure JS, no headless browser).
 */
export async function renderPdf(
  projectTitle: string,
  metrics: SprintMetrics,
  generatedAt: string,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4 portrait
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = 800;
  page.drawText("Sprint Metrics Report", {
    x: 50,
    y,
    size: 24,
    font: bold,
    color: rgb(0, 0, 0),
  });
  y -= 36;
  page.drawText(`Project: ${projectTitle}`, {
    x: 50,
    y,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  });
  y -= 20;
  page.drawText(`Generated: ${generatedAt}`, {
    x: 50,
    y,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  });
  y -= 32;

  const rows: Array<[string, string]> = [
    ["Total items", String(metrics.totalItems)],
    ["To Do", String(metrics.toDo)],
    ["In Progress (WIP)", String(metrics.inProgress)],
    ["Done (throughput)", String(metrics.done)],
    ["Other / unrecognized status", String(metrics.other)],
    ["Avg cycle time (days)", metrics.cycleTimeDays.average.toFixed(1)],
    ["Median cycle time (days)", metrics.cycleTimeDays.median.toFixed(1)],
  ];
  for (const [label, value] of rows) {
    page.drawText(`${label}: ${value}`, {
      x: 50,
      y,
      size: 12,
      font: bold,
      color: rgb(0, 0, 0),
    });
    y -= 24;
  }

  return await doc.save();
}
