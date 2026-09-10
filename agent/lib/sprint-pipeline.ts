import { fetchSprintBoard } from "./sprint-projects";
import { computeSprintMetrics } from "./sprint-metrics";
import { renderMarkdown } from "./sprint-report";
import { deliverReport } from "./sprint-delivery";

export interface RunSprintReportOptions {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  login: string;
  projectNumber: number;
}

export interface RunSprintReportResult {
  delivered: boolean;
  projectTitle?: string;
  reportUrl?: string;
  commentUrl?: string;
  metrics?: ReturnType<typeof computeSprintMetrics>;
  warnings?: string[];
  error?: string;
}

/**
 * Orchestrate the full sprint-report pipeline: fetch the board, compute
 * metrics, render markdown, and deliver it (write to `reports/` + comment on the
 * triggering issue). Returns a structured result rather than throwing.
 */
export async function runSprintReport(
  opts: RunSprintReportOptions,
): Promise<RunSprintReportResult> {
  try {
    const snapshot = await fetchSprintBoard(
      opts.token,
      opts.login,
      opts.projectNumber,
    );
    const metrics = computeSprintMetrics(snapshot);
    const generatedAt = new Date().toISOString().slice(0, 10);
    const markdown = renderMarkdown(
      snapshot.projectTitle,
      metrics,
      generatedAt,
    );
    const filename = `sprint-${generatedAt}.md`;

    const delivery = await deliverReport({
      token: opts.token,
      owner: opts.owner,
      repo: opts.repo,
      issueNumber: opts.issueNumber,
      filename,
      markdown,
    });

    return {
      delivered: true,
      projectTitle: snapshot.projectTitle,
      reportUrl: delivery.reportUrl,
      commentUrl: delivery.commentUrl,
      metrics,
      warnings: delivery.warnings,
    };
  } catch (err) {
    return {
      delivered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
