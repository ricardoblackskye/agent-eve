import { describe, it, expect, vi, afterEach } from "vitest";
import tool from "../agent/subagents/product-owner/tools/publish_story";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GH_STORY_TOKEN;
  delete process.env.GH_RELEASE_TOKEN;
  delete process.env.GITHUB_TOKEN;
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
});
