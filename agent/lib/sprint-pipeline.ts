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
 * Derive a deterministic, filesystem-safe timestamp for report filenames.
 * Always `YYYY-MM-DD-HH-MM-SS` (locale-independent, no colons which are illegal
 * in Windows paths). Throws if the input time is invalid, so a broken system
 * clock surfaces loudly instead of producing a garbage filename.
 */
export function formatTimestamp(date: Date = new Date()): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      "Invalid system clock: cannot derive report timestamp (Date is NaN).",
    );
  }
  // toISOString always yields a stable YYYY-MM-DDTHH:MM:SS.sssZ in UTC;
  // strip the 'T' and replace ':' with '-' for a colon-free, Windows-safe
  // YYYY-MM-DD-HH-MM-SS stamp.
  return date.toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/**
 * End-to-end sprint report run: read the Projects board, compute delivery
 * metrics, render Markdown + PDF, write them to the repo's reports/ folder, and
 * post a linking comment. Errors are logged (for production debugging) and
 * surfaced in the result rather than thrown.
 */
export async function runSprintReport(
  opts: RunSprintReportOptions,
): Promise<RunSprintReportResult> {
  try {
    if (!opts.projectNumber) {
      throw new Error(
        "projectNumber is required (configure SPRINT_PROJECT_NUMBER / pass projectNumber explicitly).",
      );
    }
    const owner = opts.projectOwner ?? opts.owner;
    const number = opts.projectNumber;
    const snapshot: SprintBoardSnapshot = await fetchSprintBoard(
      opts.token,
      owner,
      number,
    );
    const metrics = computeSprintMetrics(snapshot);
    const generatedAt = formatTimestamp();
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
