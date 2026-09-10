import { describe, it, expect, vi, afterEach } from "vitest";
import { deliverReport } from "../agent/lib/sprint-delivery";

describe("deliverReport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes markdown and pdf into reports/ and posts a linking comment", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchMock = vi.fn(
      async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method || "GET";
        let body: unknown;
        try {
          body = init?.body ? JSON.parse(init.body) : undefined;
        } catch {
          body = init?.body;
        }
        calls.push({ url: String(url), method, body });
        const u = String(url);
        if (u.includes("/contents/reports/sprint-1.md")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              content: {
                html_url:
                  "https://github.com/o/r/blob/main/reports/sprint-1.md",
              },
            }),
          };
        }
        if (u.includes("/contents/reports/sprint-1.pdf")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              content: {
                html_url:
                  "https://github.com/o/r/blob/main/reports/sprint-1.pdf",
              },
            }),
          };
        }
        if (u.endsWith("/comments")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              html_url: "https://github.com/o/r/issues/9#comment-1",
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverReport({
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 9,
      baseName: "sprint-1",
      markdown: "# Sprint Metrics Report\n\nhello",
      pdf: new Uint8Array([1, 2, 3, 4]),
    });

    expect(result.reportUrl).toContain("sprint-1.md");
    expect(result.reportPdfUrl).toContain("sprint-1.pdf");

    const putUrls = calls.filter((c) => c.method === "PUT").map((c) => c.url);
    expect(putUrls.some((u) => u.includes("sprint-1.md"))).toBe(true);
    expect(putUrls.some((u) => u.includes("sprint-1.pdf"))).toBe(true);

    const comment = calls.find(
      (c) => c.url.includes("/issues/9/comments") && c.method === "POST",
    );
    const commentBody = (comment?.body as { body?: string })?.body ?? "";
    expect(commentBody).toContain("sprint-1.md");
    expect(commentBody).toContain("sprint-1.pdf");
  });

  it("embeds markdown inline when the file write fails", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        let body: unknown;
        try {
          body = init?.body ? JSON.parse(init.body) : undefined;
        } catch {
          body = init?.body;
        }
        calls.push({ url: String(url), body });
        if (String(url).includes("/contents/reports/")) {
          return { ok: false, status: 422, json: async () => ({}) };
        }
        return {
          ok: true,
          status: 201,
          json: async () => ({
            html_url: "https://github.com/o/r/issues/9#comment-1",
          }),
        };
      }),
    );

    const result = await deliverReport({
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 9,
      baseName: "sprint-1",
      markdown: "# Report\n\nbody",
    });

    expect(result.reportUrl).toBeUndefined();
    expect(result.commentUrl).toBeDefined();
    const comment = calls.find((c) => c.url.includes("/issues/9/comments"));
    const commentBody = (comment?.body as { body?: string })?.body ?? "";
    expect(commentBody).toContain("body");
  });
});
