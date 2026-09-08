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

function createRequest(payload: any): NextRequest {
  const url = new URL("http://localhost:3000/api/github/webhook");
  return {
    nextUrl: url,
    method: "POST" as any,
    headers: new Headers({
      "content-type": "application/json",
      "x-github-event": "pull_request",
    }),
    text: async () => JSON.stringify(payload),
    json: async () => payload,
    blob: vi.fn().mockResolvedValue(new Blob()),
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
    bytes: vi.fn(),
  } as unknown as NextRequest;
}

const PR_BODY = {
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
};

describe("webhook secret enforcement in production", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "accepted" }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // SECURITY: `verifySignature` returned true when no secret was configured,
  // so a deployment that forgets GH_WEBHOOK_SECRET accepts forged payloads.
  it("rejects webhooks when the secret is unset in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("GH_WEBHOOK_SECRET", "");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).toBe(500);
    expect(res.data.ok).toBe(false);
    expect(res.data.error).toMatch(/secret/i);
  });

  it("rejects webhooks when the secret is undefined in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("GH_WEBHOOK_SECRET", undefined as unknown as string);

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).toBe(500);
    expect(res.data.ok).toBe(false);
  });

  it("still allows unsigned webhooks in local development", async () => {
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("GH_WEBHOOK_SECRET", "");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    // Dev keeps the permissive path so `eve dev` and evals keep working.
    expect(res.status).not.toBe(500);
  });

  // Regression: an earlier version also failed closed on VERCEL_ENV=preview.
  // Preview has no webhook secret configured and the preview eval suite posts
  // unsigned webhooks at it, so that broke CI without adding security.
  it("still allows unsigned webhooks on preview deployments", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("GH_WEBHOOK_SECRET", "");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).not.toBe(500);
  });

  it("still verifies the signature on preview when a secret IS configured", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("GH_WEBHOOK_SECRET", "preview-secret");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    // Wrong/missing signature must still be rejected when a secret exists.
    expect(res.status).toBe(401);
  });

  it("still allows unsigned webhooks when VERCEL_ENV is absent (CI / tests)", async () => {
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("GH_WEBHOOK_SECRET", "");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).not.toBe(500);
  });
});
