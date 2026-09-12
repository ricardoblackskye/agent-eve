import { describe, it, expect, vi, afterEach } from "vitest";
import tool from "../agent/subagents/product-owner/tools/publish_story";
import { sanitizeOwnerRepo } from "../agent/lib/backlog-provider";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GH_STORY_TOKEN;
  delete process.env.GH_RELEASE_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPO_OWNER;
  delete process.env.GITHUB_REPO_NAME;
  delete process.env.STORY_ALLOWED_REPOS;
});

const payload = {
  version: "1.0",
  kind: "user-story",
  story: {
    id: "US-001",
    title: "Export CSV",
    intent: "A project manager can export the sprint report as a CSV file.",
    acceptanceCriteria: [
      { given: "12 items", when: "click Export", then: "12 rows download" },
    ],
    examples: [{ input: "click Export", output: "report.csv" }],
    constraints: ["MUST NOT block the UI thread"],
    nfrs: {
      performance: "p95 < 2s",
      security: "tenant scoped",
      latency: "n/a",
    },
    openQuestions: [],
  },
  acceptanceCriteria: [
    { given: "12 items", when: "click Export", then: "12 rows download" },
  ],
  examples: [{ input: "click Export", output: "report.csv" }],
  constraints: ["MUST NOT block the UI thread"],
  nfrs: { performance: "p95 < 2s", security: "tenant scoped", latency: "n/a" },
  openQuestions: [],
  generatedAt: new Date().toISOString(),
};

describe("publish_story", () => {
  it("defaults to a dry run and never delivers", async () => {
    const r = await (tool.execute as any)(
      { payload, provider: "console" },
      {} as any,
    );
    expect(r.delivered).toBe(false);
    expect(r.mode).toBe("dry-run");
  });

  it("returns the canonical payload it was given", async () => {
    const r = await (tool.execute as any)(
      { payload, provider: "console" },
      {} as any,
    );
    expect(r.payload.story.id).toBe("US-001");
  });

  it("rejects an invalid payload rather than publishing it", async () => {
    const r = await (tool.execute as any)(
      {
        payload: { ...payload, story: { ...payload.story, intent: "x" } },
        provider: "console",
      },
      {} as any,
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("reports no-token instead of creating an issue when github is requested", async () => {
    delete process.env.GH_STORY_TOKEN;
    delete process.env.GH_RELEASE_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const r = await (tool.execute as any)(
      { payload, provider: "github", sourceIssueNumber: 7 },
      {} as any,
    );
    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/token/i);
  });

  it("surfaces the provider's issue number and label transitions", async () => {
    process.env.GH_STORY_TOKEN = "tok";
    // The allow-list gate is CLOSED by default; permit the default target.
    process.env.STORY_ALLOWED_REPOS = "ricardoblackskye/agent-eve";
    const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
      const method = init?.method || "GET";
      const u = String(url);
      if (u.endsWith("/issues") && method === "POST") {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            number: 991,
            html_url:
              "https://github.com/ricardoblackskye/agent-eve/issues/991",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await (tool.execute as any)(
      { payload, provider: "github", sourceIssueNumber: 85 },
      {} as any,
    );

    expect(r.delivered).toBe(true);
    expect(r.issueNumber).toBe(991);
    expect(r.labelTransitions).toEqual({
      add: ["user-story-added"],
      remove: ["needs-story"],
    });
  });

  it("F-1: sanitizes owner/repo BEFORE the payload reaches any provider (terminal-injection guard)", async () => {
    // The console provider echoes the canonical payload; a malicious owner/repo
    // with control chars must NOT survive into what a provider sees.
    const escAndCrlf =
      "ricardoblackskye\nINJECT" + String.fromCharCode(27) + "[31m";
    const crlfRepo = "WebFeedPOC\r\nRUN";
    const r = await (tool.execute as any)(
      {
        payload,
        provider: "console",
        owner: escAndCrlf,
        repo: crlfRepo,
      },
      {} as any,
    );
    const out = r.payload;
    // ESC (0x1b) and \n are stripped; the trailing "31m" text is allowlisted
    // alphanumerics so it survives as inert content — the security property is
    // that NO control chars reach the provider, verified below.
    expect(out.owner).toBe("ricardoblackskyeINJECT31m");
    expect(out.repo).toBe("WebFeedPOCRUN");
    expect(out.owner).not.toMatch(/[\x00-\x1f\x1b]/);
    expect(out.repo).not.toMatch(/[\x00-\x1f\x1b]/);
  });

  it("F-1: strips slashes/markdown from owner/repo in the canonical payload", async () => {
    const r = await (tool.execute as any)(
      {
        payload,
        provider: "console",
        owner: "evil/../other",
        repo: "x`rm -rf`",
      },
      {} as any,
    );
    // owner uses GitHub's stricter class (alphanumerics + hyphens only); the
    // slashes/invalid chars are stripped entirely, not preserved as dots.
    expect(r.payload.owner).toBe("evilother");
    expect(r.payload.repo).toBe("xrm-rf");
  });
});

describe("sanitizeOwnerRepo", () => {
  afterEach(() => {
    delete process.env.GITHUB_REPO_OWNER;
    delete process.env.GITHUB_REPO_NAME;
  });

  it("F-2: warns when GITHUB_REPO_OWNER is set but strips to empty (no silent fallback)", () => {
    // Underscores-only: a GitHub owner name strips to "" under the strict owner
    // class (sanitizeOwnerId), so the warning must fire. (This also guards against
    // the earlier bug where sanitizeRepoId — which KEEPS underscores — was used for
    // the check, masking the misconfiguration.)
    process.env.GITHUB_REPO_OWNER = "___";
    const { owner, warnings } = sanitizeOwnerRepo(undefined, undefined);
    expect(owner).toBe("ricardoblackskye"); // default still applies
    expect(warnings.some((w) => w.includes("GITHUB_REPO_OWNER"))).toBe(true);
  });

  it("F-2: warns for a whitespace-only GITHUB_REPO_NAME too", () => {
    process.env.GITHUB_REPO_NAME = "###";
    const { repo, warnings } = sanitizeOwnerRepo(undefined, undefined);
    expect(repo).toBe("agent-eve");
    expect(warnings.some((w) => w.includes("GITHUB_REPO_NAME"))).toBe(true);
  });

  it("does not warn when env vars are valid", () => {
    process.env.GITHUB_REPO_OWNER = "acme";
    const { owner, warnings } = sanitizeOwnerRepo(undefined, undefined);
    expect(owner).toBe("acme");
    expect(warnings).toHaveLength(0);
  });
});
