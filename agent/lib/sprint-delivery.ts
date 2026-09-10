import { Buffer } from "node:buffer";

export interface DeliverReportOptions {
  token: string;
  owner: string;
  repo: string;
  issueNumber: number;
  /** Base filename without extension, e.g. "sprint-2026-09-11". */
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
    content?: { html_url?: string };
    commit?: { html_url?: string };
  };
  return (data.content?.html_url ?? data.commit?.html_url ?? "").replace(
    "https://github.com/",
    "https://raw.githubusercontent.com/",
  );
}

/**
 * Write the sprint report (Markdown + PDF) into the repo's reports/ folder and
 * post an issue comment linking them. Timestamped filenames mean re-running the
 * report on the same day does NOT overwrite the previous run. If the file write
 * fails we fall back to a truncated inline summary comment (safe under
 * GitHub's 64k limit) rather than failing the whole pipeline.
 */
export async function deliverReport(
  opts: DeliverReportOptions,
): Promise<DeliverReportResult> {
  const mdPath = `reports/${opts.baseName}.md`;
  const pdfPath = `reports/${opts.baseName}.pdf`;

  let mdUrl: string | undefined;
  let pdfUrl: string | undefined;
  try {
    mdUrl = await writeReportFile(
      opts.token,
      opts.owner,
      opts.repo,
      mdPath,
      opts.markdown,
      false,
    );
    pdfUrl = await writeReportFile(
      opts.token,
      opts.owner,
      opts.repo,
      pdfPath,
      opts.pdf,
      true,
    );
  } catch (err) {
    mdUrl = undefined;
    pdfUrl = undefined;
    console.error("Sprint report file write failed:", err);
  }

  let commentUrl: string | undefined;
  const commentBody =
    mdUrl && pdfUrl
      ? `📊 Sprint metrics report generated.\n\n- 📄 Markdown: ${mdUrl}\n- 📕 PDF: ${pdfUrl}`
      : `⚠️ Sprint report generated but could not be written to the repo. Summary:\n\n${opts.markdown.slice(0, MAX_COMMENT_CHARS)}`;

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
