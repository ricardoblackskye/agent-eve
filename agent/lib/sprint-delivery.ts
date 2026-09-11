import { Buffer } from "node:buffer";

export interface DeliverReportOptions {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  /** Base filename without extension, e.g. "sprint-2026-09-11-14-05-09". */
  baseName: string;
  markdown: string;
  pdf: Uint8Array;
}

export interface DeliverReportResult {
  mdUrl?: string;
  pdfUrl?: string;
  commentUrl?: string;
}

const MAX_COMMENT_CHARS = 60000; // GitHub's comment limit is 65536; stay safely under.

async function writeReportFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  content: string | Uint8Array,
  isBinary: boolean,
): Promise<string> {
  const body: Record<string, unknown> = {
    message: `Sprint report: ${path}`,
    branch: "main",
  };
  if (isBinary) {
    body.content = Buffer.from(content as Uint8Array).toString("base64");
    body.encoding = "base64";
  } else {
    body.content = content as string;
  }
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Failed to write ${path}: ${res.status} ${detail}`);
  }
  const data = (await res.json()) as {
    content?: { download_url?: string };
    commit?: { html_url?: string };
  };
  // Use download_url for a direct, valid raw link (html_url points to the
  // github.com blob page and is not a raw file URL).
  return data.content?.download_url ?? data.commit?.html_url ?? "";
}

/**
 * Delete an orphaned report file via the Contents API DELETE endpoint. Best
 * effort — a failure here is logged but does not surface to the caller.
 */
async function deleteReportFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
): Promise<void> {
  try {
    const metaRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
        },
      },
    );
    const meta = (await metaRes.json()) as {
      content?: { sha?: string };
      sha?: string;
    };
    const sha = meta.content?.sha ?? meta.sha;
    if (!sha) return;
    await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: `Remove orphaned sprint report: ${path}`,
          sha,
          branch: "main",
        }),
      },
    );
  } catch (err) {
    // best-effort cleanup; don't mask the original failure
    console.error(`[sprint-delivery] orphan cleanup failed for ${path}:`, err);
  }
}

/**
 * Truncate a markdown string to at most `limit` characters, cutting on a
 * newline boundary so tables/heading rows are not split mid-line. If the slice
 * happens at EOF it is returned verbatim.
 */
export function truncateMarkdown(markdown: string, limit: number): string {
  if (markdown.length <= limit) return markdown;
  const slice = markdown.slice(0, limit);
  const lastNl = slice.lastIndexOf("\n");
  if (lastNl === -1) return slice; // single long line; best-effort
  return slice.slice(0, lastNl);
}

/**
 * Write the sprint report (Markdown + PDF) into the repo's reports/ folder and
 * post an issue comment linking them. Timestamped filenames mean re-running the
 * report on the same day does NOT overwrite the previous run. If the PDF write
 * fails after the Markdown write succeeded the orphaned Markdown is deleted;
 * otherwise a truncated (newline-safe) inline summary comment is posted.
 */
export async function deliverReport(
  opts: DeliverReportOptions,
): Promise<DeliverReportResult> {
  const mdPath = `reports/${opts.baseName}.md`;
  const pdfPath = `reports/${opts.baseName}.pdf`;

  let mdUrl: string | undefined;
  let pdfUrl: string | undefined;
  let mdSucceed = false;
  try {
    mdUrl = await writeReportFile(
      opts.token,
      opts.owner,
      opts.repo,
      mdPath,
      opts.markdown,
      false,
    );
    mdSucceed = true;
    pdfUrl = await writeReportFile(
      opts.token,
      opts.owner,
      opts.repo,
      pdfPath,
      opts.pdf,
      true,
    );
  } catch (err) {
    // if the markdown was written but the PDF failed, clean up the orphan
    if (mdSucceed && mdPath) {
      await deleteReportFile(opts.token, opts.owner, opts.repo, mdPath);
    }
    mdUrl = undefined;
    pdfUrl = undefined;
    console.error("Sprint report file write failed:", err);
  }

  let commentUrl: string | undefined;
  const commentBody =
    mdUrl && pdfUrl
      ? `📊 Sprint metrics report generated.\n\n- 📄 Markdown: ${mdUrl}\n- 📕 PDF: ${pdfUrl}`
      : `⚠️ Sprint report generated but could not be written to the repo. Summary:\n\n${truncateMarkdown(opts.markdown, MAX_COMMENT_CHARS)}`;

  const commentRes = await fetch(
    `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues/${opts.issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ body: commentBody }),
    },
  );
  if (commentRes.ok) {
    const data = (await commentRes.json()) as { html_url?: string };
    commentUrl = data.html_url;
  }

  return { mdUrl, pdfUrl, commentUrl };
}
