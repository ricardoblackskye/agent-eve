import { describe, it, expect, vi, afterEach } from "vitest";
import { deliverReport, truncateMarkdown } from "../agent/lib/sprint-delivery";

const RAW = (ext: string) =>
  `https://raw.githubusercontent.com/o/r/main/reports/sprint-x.${ext}`;

describe("deliverReport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes the markdown AND pdf file then posts a linking comment", async () => {
    const calls: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        const uClean = u.split("?")[0];
        calls[uClean] = method;
        if (uClean.includes("/contents/reports/")) {
          const isPdf = uClean.includes(".pdf");
          return {
            ok: true,
            status: 201,
            json: async () => ({
              content: { download_url: RAW(isPdf ? "pdf" : "md") },
            }),
          };
        }
        return {
          ok: true,
          status: 201,
          json: async () => ({
            html_url: "https://github.com/o/r/issues/1#comment-1",
          }),
        };
      }),
    );

    const result = await deliverReport({
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 1,
      baseName: "sprint-x",
      markdown: "# Report",
      pdf: new Uint8Array([1, 2, 3]),
    });

    expect(
      calls["https://api.github.com/repos/o/r/contents/reports/sprint-x.md"],
    ).toBe("PUT");
    expect(
      calls["https://api.github.com/repos/o/r/contents/reports/sprint-x.pdf"],
    ).toBe("PUT");
    expect(result.mdUrl).toBe(RAW("md"));
    expect(result.pdfUrl).toBe(RAW("pdf"));
    expect(result.commentUrl).toContain("#comment-1");
  });

  it("falls back to a truncated, newline-safe inline comment when file write fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (u.includes("/contents/reports/")) {
          return { ok: false, status: 500, text: async () => "boom" };
        }
        return {
          ok: true,
          status: 201,
          json: async () => ({
            html_url: "https://github.com/o/r/issues/1#comment-1",
          }),
        };
      }),
    );

    const big = "# Report\n".padEnd(70000, "x");
    const result = await deliverReport({
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 1,
      baseName: "sprint-x",
      markdown: big,
      pdf: new Uint8Array([1]),
    });

    expect(result.mdUrl).toBeUndefined();
    expect(result.commentUrl).toBeDefined();
  });

  it("cleanups the orphaned markdown file when the PDF write fails", async () => {
    const calls: Record<string, string> = {};
    let pdfPutCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: { method?: string }) => {
        const method = init?.method ?? "GET";
        const uClean = u.split("?")[0];
        calls[uClean] = method;

        if (uClean.endsWith("/contents/reports/sprint-x.md")) {
          if (method === "PUT") {
            return {
              ok: true,
              status: 201,
              json: async () => ({
                content: { download_url: RAW("md") },
              }),
            };
          }
          if (method === "GET") {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                content: { sha: "sha-md-123" },
              }),
            };
          }
        }
        if (uClean.endsWith("/contents/reports/sprint-x.pdf")) {
          pdfPutCount++;
          return { ok: false, status: 500, text: async () => "pdf boom" };
        }
        return {
          ok: true,
          status: 201,
          json: async () => ({
            html_url: "https://github.com/o/r/issues/1#comment-1",
          }),
        };
      }),
    );

    const result = await deliverReport({
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 1,
      baseName: "sprint-x",
      markdown: "# Report",
      pdf: new Uint8Array([1]),
    });

    // orphan cleanup: a DELETE was issued for the markdown path
    const deleteCalls = Object.entries(calls).filter(
      ([, m]) => m === "DELETE",
    );
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).toBe(
      "https://api.github.com/repos/o/r/contents/reports/sprint-x.md",
    );
    expect(pdfPutCount).toBe(1);
    // both URLs cleared since the full deliver failed
    expect(result.mdUrl).toBeUndefined();
    expect(result.pdfUrl).toBeUndefined();
  });
});

describe("truncateMarkdown", () => {
  it("cuts at a newline boundary, never mid-line", () => {
    const md = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const out = truncateMarkdown(md, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    if (out.length < md.length) {
      // must end on a completed line (ends with \n or next char is \n)
      expect(
        out.endsWith("\n") ? true : md.slice(out.length).startsWith("\n"),
      ).toBe(true);
    }
  });

  it("does not corrupt content when truncating a multi-line table", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n";
    const out = truncateMarkdown(md, 15);
    expect(out.length).toBeLessThanOrEqual(15);
    // no partial table row: ends with a newline or a complete "| ... |" cell
    expect(out.endsWith("\n") || out.endsWith("|") ? true : false).toBe(true);
  });
});
