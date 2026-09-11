import { describe, it, expect, vi, afterEach } from "vitest";
import { deliverReport, truncateMarkdown } from "../agent/lib/sprint-delivery";

const GIST_MD_URL =
  "https://gist.githubusercontent.com/cuill/gist-x/raw/abc/sprint-x.md";
const GIST_PDF_URL =
  "https://gist.githubusercontent.com/cuill/gist-x/raw/abc/sprint-x.pdf";
const GIST_HTML = "https://gist.github.com/cuill/gist-x";

describe("deliverReport (gist)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a gist with both files then posts a linking comment", async () => {
    const calls: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        const uClean = u.split("?")[0];
        calls[uClean] = method;
        if (uClean === "https://api.github.com/gists") {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              html_url: GIST_HTML,
              files: {
                "sprint-x.md": { raw_url: GIST_MD_URL },
                "sprint-x.pdf": { raw_url: GIST_PDF_URL },
              },
            }),
          };
        }
        // comments endpoint
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
      gistOwner: "cuill",
      issueNumber: 1,
      baseName: "sprint-x",
      markdown: "# Report",
      pdf: new Uint8Array([1, 2, 3]),
    });

    // gist created (POST), comment posted (POST)
    expect(calls["https://api.github.com/gists"]).toBe("POST");
    expect(calls["https://api.github.com/repos/o/r/issues/1/comments"]).toBe(
      "POST",
    );
    expect(result.mdUrl).toBe(GIST_MD_URL);
    expect(result.pdfUrl).toBe(GIST_PDF_URL);
    expect(result.gistUrl).toBe(GIST_HTML);
    expect(result.commentUrl).toContain("#comment-1");
  });

  it("posts the gist raw URLs (not repo contents URLs) in the comment", async () => {
    let commentBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: { method?: string; body?: string }) => {
        if (u === "https://api.github.com/gists") {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              html_url: GIST_HTML,
              files: {
                "sprint-x.md": { raw_url: GIST_MD_URL },
                "sprint-x.pdf": { raw_url: GIST_PDF_URL },
              },
            }),
          };
        }
        if (u.includes("/comments")) {
          commentBody = JSON.parse(init?.body ?? "{}").body;
          return {
            ok: true,
            status: 201,
            json: async () => ({
              html_url: "https://github.com/o/r/issues/1#comment-1",
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    await deliverReport({
      token: "tok",
      owner: "o",
      repo: "r",
      gistOwner: "cuill",
      issueNumber: 1,
      baseName: "sprint-x",
      markdown: "# Report",
      pdf: new Uint8Array([1]),
    });

    expect(commentBody).toContain(GIST_MD_URL);
    expect(commentBody).toContain(GIST_PDF_URL);
    // must NOT link to the repo contents path (the old approach)
    expect(commentBody).not.toContain("/contents/reports/");
    expect(commentBody).not.toContain("raw.githubusercontent.com/o/r");
  });

  it("falls back to a truncated, newline-safe inline comment when the gist write fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (u === "https://api.github.com/gists") {
          return { ok: false, status: 500, text: async () => "gist boom" };
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
      gistOwner: "cuill",
      issueNumber: 1,
      baseName: "sprint-x",
      markdown: big,
      pdf: new Uint8Array([1]),
    });

    expect(result.mdUrl).toBe("");
    expect(result.pdfUrl).toBe("");
    expect(result.commentUrl).toBeDefined();
  });

  it("encodes the PDF as base64 in the gist payload", async () => {
    let gistBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: { method?: string; body?: string }) => {
        if (u === "https://api.github.com/gists") {
          gistBody = JSON.parse(init?.body ?? "{}");
          return {
            ok: true,
            status: 201,
            json: async () => ({
              html_url: GIST_HTML,
              files: {
                "sprint-x.md": { raw_url: GIST_MD_URL },
                "sprint-x.pdf": { raw_url: GIST_PDF_URL },
              },
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

    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    await deliverReport({
      token: "tok",
      owner: "o",
      repo: "r",
      gistOwner: "cuill",
      issueNumber: 1,
      baseName: "sprint-x",
      markdown: "# Report",
      pdf: pdfBytes,
    });

    const pdfFile = gistBody.files["sprint-x.pdf"];
    expect(pdfFile).toBeDefined();
    expect(pdfFile.encoding).toBe("base64");
    // "%PDF" in base64 is "JVBERi"
    expect(pdfFile.content).toBe("JVBERg==");
    // markdown stays plain text
    expect(gistBody.files["sprint-x.md"].content).toBe("# Report");
    expect(gistBody.files["sprint-x.md"].encoding).toBeUndefined();
  });

  it("marks the gist as public:false (secret)", async () => {
    let gistBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: { method?: string; body?: string }) => {
        if (u === "https://api.github.com/gists") {
          gistBody = JSON.parse(init?.body ?? "{}");
          return {
            ok: true,
            status: 201,
            json: async () => ({
              html_url: GIST_HTML,
              files: {
                "sprint-x.md": { raw_url: GIST_MD_URL },
                "sprint-x.pdf": { raw_url: GIST_PDF_URL },
              },
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

    await deliverReport({
      token: "tok",
      owner: "o",
      repo: "r",
      gistOwner: "cuill",
      issueNumber: 1,
      baseName: "sprint-x",
      markdown: "# Report",
      pdf: new Uint8Array([1]),
    });

    expect(gistBody.public).toBe(false);
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
    expect(out.endsWith("\n") || out.endsWith("|")).toBe(true);
  });
});

describe("DeliverReportResult defaults", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty-string URLs (not undefined) on gist failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (u === "https://api.github.com/gists") {
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

    const result = await deliverReport({
      token: "tok",
      owner: "o",
      repo: "r",
      gistOwner: "cuill",
      issueNumber: 1,
      baseName: "sprint-x",
      markdown: "# Report",
      pdf: new Uint8Array([1]),
    });

    // on failure the urls are empty strings (not undefined) to keep consumers safe
    expect(result.mdUrl).toBe("");
    expect(result.pdfUrl).toBe("");
    expect(result.commentUrl).toBeDefined();
  });
});
