import { describe, it, expect, vi, afterEach } from "vitest";
import { deliverReport } from "../agent/lib/sprint-delivery";

describe("deliverReport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes the markdown AND pdf file then posts a linking comment", async () => {
    const calls: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: { method?: string; body?: string }) => {
        calls[u] = init?.method ?? "GET";
        if (u.includes("/contents/reports/")) {
          const isPdf = u.includes(".pdf");
          return {
            ok: true,
            status: 201,
            json: async () => ({
              content: {
                html_url: `https://github.com/o/r/blob/main/reports/sprint-x.${isPdf ? "pdf" : "md"}`,
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
    expect(result.mdUrl).toContain("/reports/sprint-x.md");
    expect(result.pdfUrl).toContain("/reports/sprint-x.pdf");
    expect(result.commentUrl).toContain("#comment-1");
  });

  it("falls back to a truncated inline comment when file write fails", async () => {
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
});
