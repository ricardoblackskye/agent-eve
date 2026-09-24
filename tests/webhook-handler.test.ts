import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

// Mock NextResponse so we can inspect the status returned to GitHub.
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data: any, init?: any) => ({
      status: init?.status ?? 200,
      body: JSON.stringify(data),
      data,
    })),
  },
}));

function createRequest(
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): NextRequest {
  const url = new URL(path, "http://localhost:3000");
  return {
    nextUrl: url,
    method: (opts.method || "POST") as any,
    headers: new Headers(
      opts.headers || { "content-type": "application/json" },
    ),
    blob: vi.fn().mockResolvedValue(new Blob()),
    text: vi.fn().mockResolvedValue(opts.body || ""),
    cookies: {} as any,
    page: {} as any,
    ua: {} as any,
    url: url.toString(),
    body: null,
    bodyUsed: false,
    cache: "default",
    credentials: "same-origin",
    destination: "",
    integrity: "",
    keepalive: false,
    mode: "same-origin",
    redirect: "follow",
    referrer: "",
    referrerPolicy: "",
    signal: new AbortController().signal,
    clone: vi.fn(),
    arrayBuffer: vi.fn(),
    formData: vi.fn(),
    json: vi.fn().mockResolvedValue(opts.body ? JSON.parse(opts.body) : {}),
  } as unknown as NextRequest;
}

const VALID_PR_BODY = JSON.stringify({
  action: "closed",
  pull_request: {
    number: 42,
    title: "Fix the thing",
    body: "Closes #39",
    html_url: "https://github.com/ricardoblackskye/agent-eve/pull/42",
    labels: [],
    state: "closed",
    merged: true,
    merged_by: { login: "ricardoblackskye" },
    base: { ref: "main" },
    head: { ref: "feat/fix" },
  },
  repository: { full_name: "ricardoblackskye/agent-eve" },
});

describe("webhook handler (bug #39)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    // Release Manager subagent is invoked via the Eve API session endpoint.
    process.env.EVE_API_KEY = "eve_sk_test";
    process.env.VERCEL_PROTECTION_BYPASS = "bypass";
    // No GH webhook secret in test env → verifySignature returns true (dev mode).
    delete process.env.GH_WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("should NOT return ok:true when the Eve API session call fails (e.g. 401)", async () => {
    // Simulate the Eve API rejecting the session POST — this is what happens in
    // production when EVE_API_KEY is missing/misconfigured or the session
    // endpoint is unreachable. GitHub must see a non-200 so it can alert/retry
    // rather than believing the release-notes update was delivered.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("../app/api/github/webhook/route");
    const request = createRequest("/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: VALID_PR_BODY,
    });

    const response: any = await POST(request as any);

    // RED assertion: the buggy handler returns status 200 with ok:true,
    // silently swallowing the Eve API 401 failure.
    expect(response.status).not.toBe(200);
    expect(response.data.ok).toBe(false);
  });

  it("should surface the Eve API failure reason in the response body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("../app/api/github/webhook/route");
    const request = createRequest("/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: VALID_PR_BODY,
    });

    const response: any = await POST(request as any);

    // The failure must be communicated back to GitHub, not masked as a success.
    expect(response.status).toBe(502);
    expect(response.data.ok).toBe(false);
    expect(response.data.error).toBeDefined();
    expect(response.data.eveApiStatus).toBe(401);
    expect(response.data.eveApiResult).toBe("error: 401");
  });

  it("should return ok:true / accepted when the Eve API session call succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "accepted", session_id: "s1" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("../app/api/github/webhook/route");
    const request = createRequest("/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: VALID_PR_BODY,
    });

    const response: any = await POST(request as any);

    expect(response.status).toBe(200);
    expect(response.data.ok).toBe(true);
    expect(response.data.eveApiResult).toBe("accepted");
  });

  // #184: the pull_request branch used to invoke Eve on EVERY action.
  function prBody(action: string, merged: boolean): string {
    return JSON.stringify({
      action,
      pull_request: {
        number: 42,
        title: "Fix the thing",
        body: "Closes #39",
        html_url: "https://github.com/ricardoblackskye/agent-eve/pull/42",
        labels: [],
        state: action === "closed" ? "closed" : "open",
        merged,
        merged_by: merged ? { login: "ricardoblackskye" } : null,
        base: { ref: "main" },
        head: { ref: "feat/fix" },
      },
      repository: { full_name: "ricardoblackskye/agent-eve" },
    });
  }

  it("does NOT call the Eve API on a non-merged pull_request event (#184)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("../app/api/github/webhook/route");

    const cases: Array<[string, boolean]> = [
      ["opened", false],
      ["synchronize", false],
      ["closed", false], // closed WITHOUT merging
    ];
    for (const [action, merged] of cases) {
      const request = createRequest("/api/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
        },
        body: prBody(action, merged),
      });
      const response: any = await POST(request as any);
      expect(response.status).toBe(200);
      expect(response.data.ok).toBe(true);
      expect(response.data.message).toContain("not a release trigger");
    }

    // The whole point of #184: zero Eve calls for non-merge PR events.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a retryable failure when run-history storage is unconfigured", async () => {
    process.env.DF_TRIGGER_LABEL = "dark-factory";
    process.env.DF_WORKER_ALLOWED_REPOS = "ricardoblackskye/agent-eve";
    process.env.DF_TRIGGER_ALLOWED_USERS = "ricardoblackskye";
    delete process.env.DF_RUN_HISTORY_DRIVER;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const body = JSON.stringify({
      action: "labeled",
      label: { name: "dark-factory" },
      sender: { login: "ricardoblackskye" },
      repository: { full_name: "ricardoblackskye/agent-eve" },
      issue: { number: 198, title: "Run ledger", body: "Persist it", labels: [{ name: "dark-factory" }] },
    });
    const { POST } = await import("../app/api/github/webhook/route");
    const response: any = await POST(createRequest("/api/github/webhook", {
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": "unconfigured-history-delivery",
      },
      body,
    }) as any);

    expect(response.status).toBe(503);
    expect(response.data.ok).toBe(false);
    expect(response.data.error).toMatch(/run history/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("STILL calls the Eve API when a PR is merged (#184 regression guard)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "accepted" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("../app/api/github/webhook/route");
    const request = createRequest("/api/github/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
      },
      body: prBody("closed", true),
    });

    const response: any = await POST(request as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.data.eveApiResult).toBe("accepted");
  });
});
