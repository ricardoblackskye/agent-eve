import { describe, it, expect, vi, afterEach } from "vitest";
import { runSprintReport } from "../agent/lib/sprint-pipeline";

function buildFetchMock(): { fetchMock: unknown } {
  const fetchMock = vi.fn(
    async (url: string | URL, init?: { method?: string }) => {
      const u = String(url);
      if (u.includes("/graphql")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              user: {
                projectV2: {
                  title: "Sprint 9",
                  items: {
                    nodes: [
                      {
                        content: {
                          number: 1,
                          title: "a",
                          createdAt: "2026-09-01T00:00:00Z",
                          closedAt: "2026-09-05T00:00:00Z",
                        },
                        fieldValues: {
                          nodes: [{ name: "Done", field: { name: "Status" } }],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        };
      }
      if (u.includes("/contents/reports/")) {
        const isPdf = u.includes(".pdf");
        return {
          ok: true,
          status: 201,
          json: async () => ({
            content: {
              html_url: `https://github.com/o/r/blob/main/reports/sprint-1.${
                isPdf ? "pdf" : "md"
              }`,
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
  return { fetchMock };
}

describe("runSprintReport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the board, computes metrics and delivers a report", async () => {
    const { fetchMock } = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runSprintReport({
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 9,
      projectOwner: "ricardoblackskye",
      projectNumber: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.projectTitle).toBe("Sprint 9");
    expect(result.reportUrl).toContain("/reports/sprint-");
    expect(result.reportPdfUrl).toContain("/reports/sprint-");
    expect(result.commentUrl).toBeDefined();
  });

  it("returns ok:false with a logged error when the board is unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })),
    );

    const result = await runSprintReport({
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 9,
      projectOwner: "ricardoblackskye",
      projectNumber: 3,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/read:project|403/i);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
