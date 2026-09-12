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
  commentPages?: Array<Array<{ body?: string }>>;
  deleteLabelStatus?: number;
  graphqlStatus?: number;
  subIssuesTotalCount?: number;
}): {
  calls: Array<{ url: string; method: string; body?: unknown }>;
  fetchMock: unknown;
} {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(
    async (url: string, init?: { method?: string; body?: string }) => {
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
            html_url: STORY_URL,
            node_id: "child-node",
          }),
        };
      }
      if (u.endsWith("/issues/85") && method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ node_id: "src-node" }),
        };
      }
      if (u.endsWith("/graphql")) {
        const status = opts.graphqlStatus ?? 200;
        const query = (body as { query?: string } | undefined)?.query ?? "";
        const resp = query.includes("totalCount")
          ? {
              data: {
                node: {
                  subIssues: { totalCount: opts.subIssuesTotalCount ?? 0 },
                },
              },
            }
          : { data: {} };
        return { ok: status < 400, status, json: async () => resp };
      }
      if (u.includes("/issues/85/comments")) {
        if (method === "GET") {
          if (opts.commentPages) {
            const page = Number.parseInt(
              new URL(u).searchParams.get("page") || "1",
              10,
            );
            return {
              ok: true,
              status: 200,
              json: async () => opts.commentPages![page - 1] ?? [],
            };
          }
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
    },
  );
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
    delete process.env.STORY_ALLOWED_REPOS;
  });

  async function publish(
    opts: Parameters<typeof stubFetch>[0],
    sourceIssueNumber = 85,
  ) {
    process.env.GH_STORY_TOKEN = "tok";
    // The allow-list gate is CLOSED by default (fail-closed). These legacy tests
    // target ricardoblackskye/agent-eve, so permit it explicitly.
    process.env.STORY_ALLOWED_REPOS = "ricardoblackskye/agent-eve";
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

  it("links the source issue in the child body (cross-reference)", async () => {
    const { result, calls } = await publish({});
    expect(result.delivered).toBe(true);

    const createCall = calls.find(
      (c) => c.url.endsWith("/issues") && c.method === "POST",
    );
    const body = (createCall?.body as { body?: string } | undefined) ?? {};
    expect(body.body).toContain(
      "[#85](https://github.com/ricardoblackskye/agent-eve/issues/85)",
    );
  });

  it("sets the source issue as the child's parent via GraphQL", async () => {
    const { result, calls } = await publish({});
    expect(result.delivered).toBe(true);

    const gqlCall = calls.find(
      (c) =>
        c.url.endsWith("/graphql") &&
        c.method === "POST" &&
        ((c.body as { query?: string })?.query ?? "").includes("addSubIssue"),
    );
    expect(gqlCall).toBeDefined();
    const gqlBody = gqlCall?.body as
      | {
          query?: string;
          variables?: { issueId?: string; subIssueId?: string };
        }
      | undefined;
    expect(gqlBody?.query).toContain("addSubIssue");
    expect(gqlBody?.variables?.issueId).toBe("src-node");
    expect(gqlBody?.variables?.subIssueId).toBe("child-node");
  });

  it("surfaces a warning (not a throw) when the parent-link GraphQL call fails", async () => {
    const { result } = await publish({ graphqlStatus: 500 });
    expect(result.delivered).toBe(true);
    expect((result.warnings ?? []).some((w) => w.includes("parent-link"))).toBe(
      true,
    );
  });

  it("skips creation when the source already has sub-issues", async () => {
    const { result, calls } = await publish({ subIssuesTotalCount: 1 });
    expect(result.delivered).toBe(false);
    expect((result as unknown as { duplicate?: boolean }).duplicate).toBe(true);
    expect(
      calls.filter((c) => c.url.endsWith("/issues") && c.method === "POST"),
    ).toHaveLength(0);
  });

  it("catches a child-link comment beyond the first page of comments", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      body: `comment ${i}`,
    }));
    const page2 = [
      { body: `📄 User story generated for this issue: ${STORY_URL}` },
    ];
    const { result, calls } = await publish({ commentPages: [page1, page2] });
    expect(result.delivered).toBe(false);
    expect((result as unknown as { duplicate?: boolean }).duplicate).toBe(true);
    expect(
      calls.filter((c) => c.url.endsWith("/issues") && c.method === "POST"),
    ).toHaveLength(0);
  });

  it("skips creation when a child already exists (dedup)", async () => {
    const { result, calls } = await publish({
      existingComments: [
        { body: `📄 User story generated for this issue: ${STORY_URL}` },
      ],
    });

    const createCalls = calls.filter(
      (c) => c.url.endsWith("/issues") && c.method === "POST",
    );
    expect(createCalls).toHaveLength(0);
    expect(result.delivered).toBe(false);
    expect((result as unknown as { duplicate?: boolean }).duplicate).toBe(true);
  });

  it("treats an already-removed trigger label (404) as success, not a warning", async () => {
    const { result } = await publish({ deleteLabelStatus: 404 });

    expect(result.delivered).toBe(true);
    // No warning raised for the benign 404 on the trigger-label delete.
    expect(
      (result.warnings ?? []).filter((w) => w.includes("remove label")),
    ).toHaveLength(0);
  });
});
