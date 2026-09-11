import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runSprintReport,
  formatTimestamp,
  type RunSprintReportOptions,
} from "../agent/lib/sprint-pipeline";

const GIST_MD =
  "https://gist.githubusercontent.com/cuill/g/main/reports/sprint-1.md";
const GIST_PDF =
  "https://gist.githubusercontent.com/cuill/g/main/reports/sprint-1.pdf";
const GIST_HTML = "https://gist.github.com/cuill/g";

function buildFetchMock(): { fetchMock: unknown } {
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === "https://api.github.com/user") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ login: "cuill" }),
      };
    }
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
    if (u === "https://api.github.com/gists") {
      // echo back the file keys the caller actually sent, so the dynamic
      // sprint-<timestamp> baseName round-trips correctly
      let keys: string[] = [];
      try {
        keys = Object.keys(
          JSON.parse((init?.body as string) || "{}").files || {},
        );
      } catch {
        keys = ["sprint-1.md", "sprint-1.pdf"];
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({
          html_url: GIST_HTML,
          files: Object.fromEntries(
            keys.map((k) => [
              k,
              { raw_url: k.endsWith(".md") ? GIST_MD : GIST_PDF },
            ]),
          ),
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
  });
  return { fetchMock };
}

describe("runSprintReport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the board, computes metrics, writes a gist, and posts a comment", async () => {
    const { fetchMock } = buildFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await runSprintReport({
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 9,
      gistOwner: "cuill",
      projectOwner: "ricardoblackskye",
      projectNumber: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.projectTitle).toBe("Sprint 9");
    expect(result.reportUrl).toBe(GIST_MD);
    expect(result.reportPdfUrl).toBe(GIST_PDF);
    expect(result.gistUrl).toBe(GIST_HTML);
    expect(result.commentUrl).toContain("#comment-1");
  });

  it("returns ok:false with a logged error when the board is unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", buildFetchMock().fetchMock); // sets up /user + gist + comments
    // override: make the /user call fine, everything else 403
    const override = vi.fn(async (u: string) => {
      if (u === "https://api.github.com/user") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ login: "cuill" }),
        };
      }
      return { ok: false, status: 403, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", override);

    const result = await runSprintReport({
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 9,
      gistOwner: "cuill",
      projectOwner: "ricardoblackskye",
      projectNumber: 3,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/read:project|403/i);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("fails fast when gistOwner is missing", async () => {
    vi.stubGlobal("fetch", buildFetchMock().fetchMock);
    // deliberately omit gistOwner — cast to bypass the type guard so this
    // simulates a real caller mistake at runtime, not a compile error
    const opts = {
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 9,
      projectOwner: "ricardoblackskye",
      projectNumber: 3,
      // no gistOwner
    } as RunSprintReportOptions;
    const result = await runSprintReport(opts);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/gistOwner is required/i);
  });

  it("fails fast when projectNumber is missing", async () => {
    vi.stubGlobal("fetch", buildFetchMock().fetchMock);
    const opts = {
      token: "tok",
      owner: "o",
      repo: "r",
      issueNumber: 9,
      gistOwner: "cuill",
      projectOwner: "ricardoblackskye",
      // no projectNumber
    } as RunSprintReportOptions;
    const result = await runSprintReport(opts);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/projectNumber is required/i);
  });
});

describe("formatTimestamp", () => {
  it("produces a filesystem-safe YYYY-MM-DD-HH-MM-SS stamp", () => {
    const stamp = formatTimestamp(new Date("2026-09-11T14:05:09.000Z"));
    expect(stamp).toBe("2026-09-11-14-05-09");
  });

  it("throws on an invalid (NaN) system clock", () => {
    expect(() => formatTimestamp(new Date("not-a-date"))).toThrow(/timestamp/i);
  });

  it("never contains characters illegal in Windows paths (: / \\)", () => {
    const stamp = formatTimestamp();
    expect(stamp).not.toMatch(/[:/\\]/);
  });
});

describe("runSprintReport (live, gated)", () => {
  // Requires GH_SPRINT_TOKEN with read:project + gist scope.
  const liveToken = process.env.GH_SPRINT_TOKEN;
  (liveToken ? it : it.skip)(
    "LIVE: generates a real gist from the ricardoblackskye #3 board",
    async () => {
      const res = await runSprintReport({
        token: liveToken!,
        owner: "ricardoblackskye",
        repo: "agent-eve",
        issueNumber: 106,
        gistOwner: "ricardoblackskye",
        projectOwner: "ricardoblackskye",
        projectNumber: 3,
      });
      expect(res.ok).toBe(true);
      expect(res.reportUrl).toContain("gist.githubusercontent.com");
      expect(res.reportPdfUrl).toContain("gist.githubusercontent.com");
      expect(res.gistUrl).toContain("gist.github.com");
      expect(res.commentUrl).toContain("issues/106");
    },
    30000,
  );
});
