import { describe, it, expect, vi, afterEach } from "vitest";
import { deliverReport } from "../agent/lib/sprint-delivery";

describe("deliverReport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("writes the report into reports/ and posts a linking comment", async () => {
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
        if (String(url).includes("/contents/reports/")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              content: {
                html_url:
                  "https://github.com/ricardoblackskye/agent-eve/blob/main/reports/sprint-1.md",
              },
            }),
          };
        }
        if (String(url).endsWith("/comments")) {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              html_url:
                "https://github.com/ricardoblackskye/agent-eve/issues/9#comment-1",
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await deliverReport({
      token: "tok",
      owner: "ricardoblackskye",
      repo: "agent-eve",
      issueNumber: 9,
      filename: "sprint-1.md",
      markdown: "# Sprint Metrics Report\n\nhello",
    });

    expect(result.reportUrl).toContain("/reports/sprint-1.md");
    expect(result.commentUrl).toContain("comment-1");

    const put = calls.find((c) =>
      c.url.includes("/contents/reports/sprint-1.md"),
    );
    expect(put?.method).toBe("PUT");
    const putBody = put?.body as { content?: string };
    expect(typeof putBody.content).toBe("string"); // base64

    const comment = calls.find(
      (c) => c.url.includes("/issues/9/comments") && c.method === "POST",
    );
    expect(comment).toBeDefined();
    const commentBody = (comment?.body as { body?: string })?.body ?? "";
    expect(commentBody).toContain("reports/sprint-1.md");
  });

  it("falls back to embedding the markdown when the file write fails", async () => {
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
          json: async () => ({ html_url: "https://...com/comment" }),
        };
      }),
    );

    const result = await deliverReport({
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 9,
      filename: "sprint-1.md",
      markdown: "# Report\n\nbody",
    });

    expect(result.reportUrl).toBeUndefined();
    expect(result.commentUrl).toBeDefined();
    const comment = calls.find((c) => c.url.includes("/issues/9/comments"));
    const commentBody = (comment?.body as { body?: string })?.body ?? "";
    expect(commentBody).toContain("body"); // markdown embedded inline
  });
});
