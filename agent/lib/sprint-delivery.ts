import { Buffer } from "node:buffer";

export interface DeliverReportOptions {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  filename: string;
  markdown: string;
}

export interface DeliverReportResult {
  reportUrl?: string;
  commentUrl?: string;
  warnings?: string[];
  error?: string;
}

const AUTH = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "x-github-api-version": "2022-11-28",
});

/**
 * Deliver a rendered sprint report: write it into the `reports/` folder via the
 * contents API, then post a comment on the triggering issue linking to it (or
 * embedding the markdown inline as a fallback). Best-effort: a failed file write
 * or comment surfaces as a warning rather than throwing.
 */
export async function deliverReport(
  opts: DeliverReportOptions,
): Promise<DeliverReportResult> {
  const warnings: string[] = [];
  let reportUrl: string | undefined;

  // 1. Commit the report into reports/.
  try {
    const putRes = await fetch(
      `https://api.github.com/repos/${opts.owner}/${opts.repo}/contents/reports/${opts.filename}`,
      {
        method: "PUT",
        headers: AUTH(opts.token),
        body: JSON.stringify({
          message: `Add sprint metrics report ${opts.filename}`,
          content: Buffer.from(opts.markdown, "utf8").toString("base64"),
        }),
      },
    );
    if (putRes.ok) {
      const data = (await putRes.json()) as { content?: { html_url?: string } };
      reportUrl = data.content?.html_url;
    } else {
      warnings.push(`report file write failed (${putRes.status})`);
    }
  } catch (err) {
    warnings.push(
      `report file write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Post a comment linking to the report (or embedding the markdown).
  const commentBody = reportUrl
    ? `📊 Sprint metrics report generated.\n\n${reportUrl}`
    : `📊 Sprint metrics report generated:\n\n${opts.markdown}`;

  let commentUrl: string | undefined;
  try {
    const cRes = await fetch(
      `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues/${opts.issueNumber}/comments`,
      {
        method: "POST",
        headers: AUTH(opts.token),
        body: JSON.stringify({ body: commentBody }),
      },
    );
    if (cRes.ok) {
      const data = (await cRes.json()) as { html_url?: string };
      commentUrl = data.html_url;
    } else {
      warnings.push(`report comment failed (${cRes.status})`);
    }
  } catch (err) {
    warnings.push(
      `report comment failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    reportUrl,
    commentUrl,
    warnings: warnings.length ? warnings : undefined,
  };
}
