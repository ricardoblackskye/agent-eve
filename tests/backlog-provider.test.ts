import { describe, it, expect, vi, afterEach } from "vitest";
import {
  toCanonicalPayload,
  getProvider,
  type BacklogProvider,
} from "../agent/lib/backlog-provider";
import type { UserStory } from "../agent/lib/story-schema";

const story: UserStory = {
  id: "US-001",
  title: "Export report as CSV",
  intent: "A project manager can export the sprint report as CSV.",
  acceptanceCriteria: [
    { given: "12 items", when: "click Export", then: "12 rows download" },
  ],
  examples: [{ input: "click Export", output: "report.csv" }],
  constraints: ["MUST NOT block the UI thread"],
  nfrs: { performance: "p95 < 2s", security: "tenant scoped", latency: "n/a" },
  openQuestions: [],
};

const STORY_URL = "https://github.com/ricardoblackskye/agent-eve/issues/991";

function stubFetch(opts: {
  existingComments?: Array<{ body?: string }>;
  deleteLabelStatus?: number;
}): { calls: Array<{ url: string; method: string }>; fetchMock: unknown } {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method || "GET";
    const u = String(url);
    calls.push({ url: u, method });
    if (u.endsWith("/issues") && method === "POST") {
      return {
        ok: true,
        status: 201,
        json: async () => ({ number: 991, html_url: STORY_URL }),
      };
    }
    if (u.endsWith("/issues/85/comments")) {
      if (method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => opts.existingComments ?? [],
        };
      }
      return { ok: true, status: 201, json: async () => ({}) };
    }
    if (u.endsWith("/issues/85/labels") && method === "POST") {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (u.endsWith("/issues/85/labels/needs-story") && method === "DELETE") {
      const status = opts.deleteLabelStatus ?? 200;
      return { ok: status < 400, status, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return { calls, fetchMock };
}

describe("toCanonicalPayload", () => {
  it("is platform neutral — no provider-specific fields", () => {
    const json = JSON.stringify(toCanonicalPayload(story));
    expect(json).not.toMatch(/azure|devops|jira|github/i);
  });

  it("carries every section of the story", () => {
    const p = toCanonicalPayload(story);
    expect(p.story.id).toBe("US-001");
    expect(p.acceptanceCriteria).toHaveLength(1);
    expect(p.nfrs).toBeDefined();
  });
});

describe("getProvider", () => {
  it("defaults to the console provider (dry run)", () => {
    expect(getProvider("console").id).toBe("console");
  });

  it("console provider never performs a network call", async () => {
    const p: BacklogProvider = getProvider("console");
    const res = await p.publish(toCanonicalPayload(story));
    expect(res.delivered).toBe(false);
    expect(res.mode).toBe("dry-run");
  });

  it("returns a not-configured result for an unknown provider", async () => {
    const res = await getProvider("nonexistent").publish(
      toCanonicalPayload(story),
    );
    expect(res.delivered).toBe(false);
  });
});

describe("GitHubProvider.publish", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete process.env.GH_STORY_TOKEN;
    delete process.env.GH_RELEASE_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  async function publish(
    opts: Parameters<typeof stubFetch>[0],
    sourceIssueNumber = 85,
  ) {
    process.env.GH_STORY_TOKEN = "tok";
    const { calls, fetchMock } = stubFetch(opts);
    vi.stubGlobal("fetch", fetchMock);
    const result = await getProvider("github").publish({
      ...toCanonicalPayload(story),
      sourceIssueNumber,
    });
    return { result, calls };
  }

  it("returns the created issue number on success", async () => {
    const { result } = await publish({}, 0);
    expect(result.delivered).toBe(true);
    expect((result as unknown as { issueNumber?: number }).issueNumber).toBe(
      991,
    );
  });

  it("links the child story and transitions labels on the source issue", async () => {
    const { result, calls } = await publish({});
    expect(result.delivered).toBe(true);
    const r = result as unknown as {
      issueNumber?: number;
      labelTransitions?: { add: string[]; remove: string[] };
    };
    expect(r.issueNumber).toBe(991);
    expect(r.labelTransitions).toEqual({
      add: ["user-story-added"],
      remove: ["needs-story"],
    });

    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.endsWith("/issues"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/issues/85/comments"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/issues/85/labels"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/issues/85/labels/needs-story"))).toBe(
      true,
    );
  });

  it("does not post a duplicate child-link comment when one already exists", async () => {
    const { result, calls } = await publish({
      existingComments: [
        { body: `📄 User story generated for this issue: ${STORY_URL}` },
      ],
    });

    expect(result.delivered).toBe(true);
    const commentPosts = calls.filter(
      (c) => c.url.endsWith("/issues/85/comments") && c.method === "POST",
    );
    expect(commentPosts).toHaveLength(0);
    expect(result.warnings).toBeUndefined();
  });

  it("treats an already-removed trigger label (404) as success, not a warning", async () => {
    const { result } = await publish({ deleteLabelStatus: 404 });

    expect(result.delivered).toBe(true);
    // No warning raised for the benign 404 on the trigger-label delete.
    expect((result.warnings ?? []).filter((w) => w.includes("remove label"))).toHaveLength(
      0,
    );
  });
});