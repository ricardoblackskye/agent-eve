import { Buffer } from "node:buffer";

export interface DeliverReportOptions {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  /** Base filename without extension, e.g. "sprint-2026-09-10". */
  baseName: string;
  markdown: string;
  /** R2: optional PDF bytes, written to `reports/<baseName>.pdf`. */
  pdf?: Uint8Array;
}

export interface DeliverReportResult {
  reportUrl?: string;
  reportPdfUrl?: string;
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

async function writeReportFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  base64Content: string,
): Promise<{ url?: string; warning?: string }> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/reports/${path}`,
      {
        method: "PUT",
        headers: AUTH(token),
        body: JSON.stringify({
          message: `Add sprint metrics report ${path}`,
          content: base64Content,
        }),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as { content?: { html_url?: string } };
      return { url: data.content?.html_url };
    }
    return { warning: `report file write failed (${path}: ${res.status})` };
  } catch (err) {
    return {
      warning: `report file write failed (${path}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Deliver a rendered sprint report: write the markdown (and optional PDF) into
 * the `reports/` folder via the contents API, then post a linking comment on the
 * triggering issue. Best-effort: failures surface as warnings, never throw.
 */
export async function deliverReport(
  opts: DeliverReportOptions,
): Promise<DeliverReportResult> {
  const warnings: string[] = [];
  const base = opts.baseName;

  const md = await writeReportFile(
    opts.token,
    opts.owner,
    opts.repo,
    `${base}.md`,
    Buffer.from(opts.markdown, "utf8").toString("base64"),
  );
  if (md.warning) warnings.push(md.warning);

  let reportPdfUrl: string | undefined;
  if (opts.pdf) {
    const pdf = await writeReportFile(
      opts.token,
      opts.owner,
      opts.repo,
      `${base}.pdf`,
      Buffer.from(opts.pdf).toString("base64"),
    );
    reportPdfUrl = pdf.url;
    if (pdf.warning) warnings.push(pdf.warning);
  }

  const links = [md.url, reportPdfUrl].filter(Boolean) as string[];
  const commentBody = links.length
    ? `📊 Sprint metrics report generated.\n\n${links.join("\n\n")}`
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
    reportUrl: md.url,
    reportPdfUrl,
    commentUrl,
    warnings: warnings.length ? warnings : undefined,
  };
}
