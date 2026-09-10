import { describe, it, expect, vi, afterEach } from "vitest";
import tool from "../agent/subagents/product-owner/tools/comment_questions";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.GH_STORY_TOKEN;
  delete process.env.GH_RELEASE_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

describe("comment_questions", () => {
  it("does not post duplicate clarifying comments when questions are already present", async () => {
    process.env.GH_STORY_TOKEN = "tok";
    const methods: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      const method = init?.method || "GET";
      methods.push(method);
      if (method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              body: "1. What is the target platform? 2. What is the CSV delimiter?",
            },
          ],
        };
      }
      return { ok: true, status: 201, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await (tool.execute as any)(
      {
        owner: "ricardoblackskye",
        repo: "agent-eve",
        issueNumber: 7,
        questions: [
          "What is the target platform?",
          "What is the CSV delimiter?",
        ],
      },
      {} as any,
    );

    expect(r.commented).toBe(false);
    expect(r.duplicate).toBe(true);
    expect(methods).toEqual(["GET"]);
  });

  it("still posts when no existing comment matches", async () => {
    process.env.GH_STORY_TOKEN = "tok";
    const methods: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { method?: string }) => {
      const method = init?.method || "GET";
      methods.push(method);
      if (method === "GET") {
        return { ok: true, status: 200, json: async () => [] };
      }
      return { ok: true, status: 201, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await (tool.execute as any)(
      {
        owner: "ricardoblackskye",
        repo: "agent-eve",
        issueNumber: 7,
        questions: ["What is the target platform?"],
      },
      {} as any,
    );

    expect(r.commented).toBe(true);
    expect(methods).toEqual(["GET", "POST"]);
  });
});