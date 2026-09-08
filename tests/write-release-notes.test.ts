import { describe, it, expect, vi, afterEach } from "vitest";
import tool from "../agent/subagents/release-manager/tools/write_release_notes";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GH_RELEASE_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

/**
 * `defineTool` types `execute` as a union that can include AsyncIterable
 * (streaming tools). This tool always returns a plain object, so await once
 * and narrow, rather than casting at every call site.
 */
async function run(
  input: Record<string, unknown>,
): Promise<Record<string, any>> {
  const result = await (tool.execute as any)(input, {} as any);
  return result as Record<string, any>;
}

describe("write_release_notes (#80)", () => {
  it("returns a specific error when no token is configured", async () => {
    delete process.env.GH_RELEASE_TOKEN;
    delete process.env.GITHUB_TOKEN;

    const r = await run({ content: "x" });

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/GH_RELEASE_TOKEN/);
  });

  it("distinguishes a 403 (token scope) from other API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ message: "Resource not accessible" }),
      }),
    );
    process.env.GH_RELEASE_TOKEN = "tok";

    const r = await run({ content: "x" });

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/403|scope|Contents/i);
  });

  it("includes the HTTP status in every error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ message: "Invalid" }),
      }),
    );
    process.env.GH_RELEASE_TOKEN = "tok";

    const r = await run({ content: "x" });

    expect(r.error).toMatch(/422/);
  });

  it("falls back to GITHUB_TOKEN when GH_RELEASE_TOKEN is unset", async () => {
    // app/api/releasenotes/route.ts already does this; the write path did not.
    delete process.env.GH_RELEASE_TOKEN;
    process.env.GITHUB_TOKEN = "gh-tok";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: { sha: "abc" }, commit: { sha: "def" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await run({ content: "x" });

    expect(r.success).toBe(true);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.authorization).toBe("Bearer gh-tok");
  });

  it("prefers GH_RELEASE_TOKEN when both are set", async () => {
    process.env.GH_RELEASE_TOKEN = "release-tok";
    process.env.GITHUB_TOKEN = "gh-tok";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: { sha: "abc" }, commit: { sha: "def" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await run({ content: "x" });

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.authorization).toBe("Bearer release-tok");
  });
});
