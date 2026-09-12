import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getProvider,
  toCanonicalPayload,
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

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

function stubFetch() {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method || "GET";
    const u = String(url);
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = init?.body;
    }
    calls.push({ url: u, method, body });
    if (u.endsWith("/issues") && method === "POST") {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          number: 991,
          html_url: "https://github.com/ricardoblackskye/WebFeedPOC/issues/991",
          node_id: "child-node",
        }),
      };
    }
    if (/\/issues\/\d+$/.test(u) && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ node_id: "src-node" }) };
    }
    if (u.endsWith("/graphql")) {
      const query = (body as { query?: string } | undefined)?.query ?? "";
      const resp = query.includes("totalCount")
        ? { data: { node: { subIssues: { totalCount: 0 } } } }
        : { data: {} };
      return { ok: true, status: 200, json: async () => resp };
    }
    if (u.includes("/comments")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (u.endsWith("/labels") && method === "POST") {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (u.includes("/labels/") && method === "DELETE") {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  return { calls, fetchMock };
}

describe("GitHubProvider honors source owner/repo from payload (issue #119)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete process.env.GH_STORY_TOKEN;
    delete process.env.GH_RELEASE_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPO_OWNER;
    delete process.env.GITHUB_REPO_NAME;
    delete process.env.STORY_ALLOWED_REPOS;
  });

  async function publish(
    extra: { owner?: string; repo?: string },
    opts: { setAllowList?: boolean } = {},
  ) {
    process.env.GH_STORY_TOKEN = "tok";
    // The allow-list gate is CLOSED by default; the happy-path tests opt in by
    // setting STORY_ALLOWED_REPOS so real creation is exercised.
    if (opts.setAllowList !== false) {
      process.env.STORY_ALLOWED_REPOS =
        "ricardoblackskye/agent-eve,ricardoblackskye/WebFeedPOC";
    }
    const { calls, fetchMock } = stubFetch();
    vi.stubGlobal("fetch", fetchMock);
    const result = await getProvider("github").publish({
      ...toCanonicalPayload(story),
      sourceIssueNumber: 85,
      ...extra,
    });
    return { result, calls };
  }

  it("creates the story in the source repo (WebFeedPOC), NOT agent-eve", async () => {
    const { result, calls } = await publish({
      owner: "ricardoblackskye",
      repo: "WebFeedPOC",
    });
    expect(result.delivered).toBe(true);
    const createCall = calls.find(
      (c) => c.url.endsWith("/issues") && c.method === "POST",
    );
    expect(createCall?.url).toBe(
      "https://api.github.com/repos/ricardoblackskye/WebFeedPOC/issues",
    );
  });

  it("finalizes (comment/labels) on the SOURCE repo issue, not agent-eve", async () => {
    const { calls } = await publish({ owner: "ricardoblackskye", repo: "WebFeedPOC" });
    const urls = calls.map((c) => c.url);
    // every source-issue read/write must target WebFeedPOC/85, never agent-eve/85
    for (const u of urls) {
      if (u.includes("/issues/85")) {
        expect(u).toContain("WebFeedPOC");
      }
    }
    expect(urls.some((u) => u.includes("agent-eve/issues/85"))).toBe(false);
  });

  it("falls back to env vars when payload owner/repo omitted", async () => {
    process.env.GITHUB_REPO_OWNER = "acme";
    process.env.GITHUB_REPO_NAME = "widget";
    process.env.STORY_ALLOWED_REPOS = "acme/widget";
    const { calls } = await publish({}, { setAllowList: false });
    const createCall = calls.find(
      (c) => c.url.endsWith("/issues") && c.method === "POST",
    );
    expect(createCall?.url).toBe(
      "https://api.github.com/repos/acme/widget/issues",
    );
    delete process.env.STORY_ALLOWED_REPOS;
  });

  it("falls back to agent-eve default when no payload/env owner/repo", async () => {
    const { calls } = await publish({});
    const createCall = calls.find(
      (c) => c.url.endsWith("/issues") && c.method === "POST",
    );
    expect(createCall?.url).toBe(
      "https://api.github.com/repos/ricardoblackskye/agent-eve/issues",
    );
  });

  // --- Security fixes for PR #120 review findings ---

  it("REJECTS a target repo outside the STORY_ALLOWED_REPOS allow-list (arbitrary-repo guard)", async () => {
    process.env.STORY_ALLOWED_REPOS = "ricardoblackskye/agent-eve,ricardoblackskye/WebFeedPOC";
    const { result, calls } = await publish({
      owner: "evil",
      repo: "malicious",
    });
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/not in the allow-list|allow/i);
    expect(
      calls.filter((c) => c.url.endsWith("/issues") && c.method === "POST"),
    ).toHaveLength(0);

    delete process.env.STORY_ALLOWED_REPOS;
  });

  it("FAILS CLOSED: refuses to publish when STORY_ALLOWED_REPOS is unset (gate not silently open)", async () => {
    // The gate must be CLOSED by default. With the env var absent, even a valid
    // configured repo is refused (not silently allowed), so a misconfigured
    // deployment cannot lose the allow-list defense.
    const { result, calls } = await publish(
      { owner: "ricardoblackskye", repo: "WebFeedPOC" },
      { setAllowList: false },
    );
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/STORY_ALLOWED_REPOS is not configured/i);
    expect(
      calls.filter((c) => c.url.endsWith("/issues") && c.method === "POST"),
    ).toHaveLength(0);

    delete process.env.STORY_ALLOWED_REPOS;
  });

  it("ALLOWS a target repo that is in the allow-list", async () => {
    process.env.STORY_ALLOWED_REPOS = "ricardoblackskye/agent-eve,ricardoblackskye/WebFeedPOC";
    const { result, calls } = await publish({
      owner: "ricardoblackskye",
      repo: "WebFeedPOC",
    });
    expect(result.delivered).toBe(true);
    const createCall = calls.find(
      (c) => c.url.endsWith("/issues") && c.method === "POST",
    );
    expect(createCall?.url).toBe(
      "https://api.github.com/repos/ricardoblackskye/WebFeedPOC/issues",
    );

    delete process.env.STORY_ALLOWED_REPOS;
  });

  it("re-sanitizes owner/repo at the provider boundary — strips control chars/newlines", async () => {
    // Note: the allow-list gate permits exactly the sanitized target so this test
    // isolates the sanitization behavior (the gate itself is covered elsewhere).
    process.env.STORY_ALLOWED_REPOS =
      "ricardoblackskyeINJECT/WebFeedPOCRUN";
    const { calls } = await publish(
      {
        owner: "ricardoblackskye\nINJECT",
        repo: "WebFeedPOC\rRUN",
      },
      { setAllowList: false },
    );
    const createCall = calls.find(
      (c) => c.url.endsWith("/issues") && c.method === "POST",
    );
    // The security property: no control chars / newlines survive into the URL.
    expect(createCall?.url).not.toContain("\n");
    expect(createCall?.url).not.toContain("\r");
    expect(createCall?.url).not.toMatch(/[\x00-\x1f]/);
    delete process.env.STORY_ALLOWED_REPOS;
  });
});
