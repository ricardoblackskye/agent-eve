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

  it("returns the created issue number on success", async () => {
    process.env.GH_STORY_TOKEN = "tok";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        number: 991,
        html_url: "https://github.com/ricardoblackskye/agent-eve/issues/991",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = getProvider("github");
    const result = await provider.publish({
      ...toCanonicalPayload(story),
      sourceIssueNumber: 85,
    });

    expect(result.delivered).toBe(true);
    expect((result as unknown as { issueNumber?: number }).issueNumber).toBe(
      991,
    );
  });
});