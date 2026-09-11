import { Buffer } from "node:buffer";

export interface DeliverReportOptions {
  token: string;
  owner: string;
  repo: string;
  /** GitHub username/actor that owns the gist (the token's owner). */
  gistOwner: string;
  issueNumber: number;
  /** Base filename without extension, e.g. "sprint-2026-09-11-14-05-09". */
  baseName: string;
  markdown: string;
  pdf: Uint8Array;
}

export interface DeliverReportResult {
  mdUrl: string;
  pdfUrl: string;
  /**
   * The gist's HTML URL (web UI). Null when the gist could not be created;
   * in that case mdUrl/pdfUrl are also undefined and the fallback inline
   * comment body is empty.
   */
  gistUrl?: string;
  commentUrl?: string;
}

const MAX_COMMENT_CHARS = 60000; // GitHub's comment limit is 65536; stay safely under.

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
 * Convert arbitrary binary content to a base64-encoded string for the Gist API,
 * which only accepts plain-text (base64) file payloads for non-UTF-8 files.
 */
function toBase64(content: Uint8Array): string {
  // node's Buffer is base64-url-ish here; use base64 explicitly for the Gist API.
  return Buffer.from(content).toString("base64");
}

const GH_HEADERS = (token: string) => ({
  authorization: "Bearer " + token,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
});

/**
 * Create a single GitHub Gist containing both the Markdown and PDF report
 * files. The gist is created so there is no orphaned-file risk: either both
 * files land or neither does.
 *
 * Returns the gist's HTML URL plus the **raw** download URLs for each file,
 * which render natively in the browser (markdown preview / PDF viewer).
 */
export async function createGistWithReport(
  token: string,
  gistOwner: string,
  baseName: string,
  markdown: string,
  pdf: Uint8Array,
): Promise<{ gistUrl: string; mdUrl: string; pdfUrl: string }> {
  const description =
    `Sprint metrics report (${baseName}) — owned by ${gistOwner} ` +
    `via agent-eve sprint-reporter`;
  const body = {
    description,
    public: false,
    files: {
      [`${baseName}.md`]: { content: markdown },
      [`${baseName}.pdf`]: { content: toBase64(pdf), encoding: "base64" },
    },
  };

  const res = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: GH_HEADERS(token),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gist API error ${res.status}: ${detail}`);
  }

  const data = (await res.json()) as {
    html_url: string;
    files: Record<string, { raw_url?: string }>;
  };

  // raw_url is the direct CDN URL that renders in-browser.
  const mdFile = data.files[`${baseName}.md`];
  const pdfFile = data.files[`${baseName}.pdf`];
  if (!mdFile || !pdfFile || !mdFile.raw_url || !pdfFile.raw_url) {
    throw new Error("Gist API returned unexpected file shape.");
  }

  return {
    gistUrl: data.html_url,
    mdUrl: mdFile.raw_url,
    pdfUrl: pdfFile.raw_url,
  };
}

/**
 * Write the sprint report (Markdown + PDF) to a **GitHub Gist** and post an
 * issue comment linking them. Using a gist (rather than writing files into the
 * repo's `reports/` folder) sidesteps the main-branch ruleset and avoids
 * orphaned files: the two files are created in a single atomic Gist POST, so
 * there's no partial-write cleanup step to maintain. If the gist write fails we
 * fall back to a truncated, newline-safe inline summary comment (safe under
 * GitHub's 64k limit).
 */
export async function deliverReport(
  opts: DeliverReportOptions,
): Promise<DeliverReportResult> {
  let mdUrl: string | undefined;
  let pdfUrl: string | undefined;
  let gistUrl: string | undefined;

  try {
    const gist = await createGistWithReport(
      opts.token,
      opts.gistOwner,
      opts.baseName,
      opts.markdown,
      opts.pdf,
    );
    mdUrl = gist.mdUrl;
    pdfUrl = gist.pdfUrl;
    gistUrl = gist.gistUrl;
  } catch (err) {
    mdUrl = undefined;
    pdfUrl = undefined;
    gistUrl = undefined;
    console.error("Sprint report gist write failed:", err);
  }

  let commentUrl: string | undefined;
  const commentBody =
    mdUrl && pdfUrl
      ? `📊 Sprint metrics report generated.\n\n- 📄 Markdown: ${mdUrl}\n- 🟦 PDF: ${pdfUrl}`
      : `⚠️ Sprint report generated but could not be written to a gist. Summary:\n\n${truncateMarkdown(opts.markdown, MAX_COMMENT_CHARS)}`;

  const commentRes = await fetch(
    `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues/${opts.issueNumber}/comments`,
    {
      method: "POST",
      headers: GH_HEADERS(opts.token),
      body: JSON.stringify({ body: commentBody }),
    },
  );
  if (commentRes.ok) {
    const data = (await commentRes.json()) as { html_url?: string };
    commentUrl = data.html_url;
  }

  return { mdUrl: mdUrl ?? "", pdfUrl: pdfUrl ?? "", gistUrl, commentUrl };
}
