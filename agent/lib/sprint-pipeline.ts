import { renderMarkdown, renderPdf } from "./sprint-report";
import { computeSprintMetrics, type SprintMetrics } from "./sprint-metrics";
import { fetchSprintBoard, type SprintBoardSnapshot } from "./sprint-projects";
import { deliverReport } from "./sprint-delivery";

export interface RunSprintReportOptions {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  projectOwner?: string;
  projectNumber?: number;
}

export interface RunSprintReportResult {
  ok: boolean;
  projectTitle?: string;
  metrics?: SprintMetrics;
  reportUrl?: string;
  reportPdfUrl?: string;
  commentUrl?: string;
  error?: string;
}

/**
 * End-to-end sprint report run: read the Projects board, compute delivery
 * metrics, render Markdown + PDF, write them to the repo's reports/ folder,
 * and post a linking comment. Errors are logged (for production debugging)
 * and surfaced in the result rather than thrown.
 */
export async function runSprintReport(
  opts: RunSprintReportOptions,
): Promise<RunSprintReportResult> {
  try {
    const owner = opts.projectOwner ?? opts.owner;
    const number = opts.projectNumber ?? 3;
    const snapshot: SprintBoardSnapshot = await fetchSprintBoard(
      opts.token,
      owner,
      number,
    );
    const metrics = computeSprintMetrics(snapshot);
    const generatedAt = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-"); // 2026-09-11-14-05-09
    const markdown = renderMarkdown(
      snapshot.projectTitle,
      metrics,
      generatedAt,
    );
    const pdf = await renderPdf(snapshot.projectTitle, metrics, generatedAt);
    const baseName = `sprint-${generatedAt}`;

    const delivery = await deliverReport({
      token: opts.token,
      owner: opts.owner,
      repo: opts.repo,
      issueNumber: opts.issueNumber,
      baseName,
      markdown,
      pdf,
    });

    return {
      ok: true,
      projectTitle: snapshot.projectTitle,
      metrics,
      reportUrl: delivery.mdUrl,
      reportPdfUrl: delivery.pdfUrl,
      commentUrl: delivery.commentUrl,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sprint-pipeline] runSprintReport failed:", message);
    return { ok: false, error: message };
  }
}
