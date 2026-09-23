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
    vi.stubEnv("DF_PLATFORM_PROVIDER", "vercel");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("GH_WEBHOOK_SECRET", "");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).toBe(500);
    expect(res.data.ok).toBe(false);
    expect(res.data.error).toMatch(/secret/i);
  });

  it("rejects webhooks when the secret is undefined in production", async () => {
    vi.stubEnv("DF_PLATFORM_PROVIDER", "vercel");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("GH_WEBHOOK_SECRET", undefined as unknown as string);

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).toBe(500);
    expect(res.data.ok).toBe(false);
  });

  it("still allows unsigned webhooks in local development", async () => {
    vi.stubEnv("DF_PLATFORM_PROVIDER", "vercel");
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
    vi.stubEnv("DF_PLATFORM_PROVIDER", "vercel");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("GH_WEBHOOK_SECRET", "");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).not.toBe(500);
  });

  it("still verifies the signature on preview when a secret IS configured", async () => {
    vi.stubEnv("DF_PLATFORM_PROVIDER", "vercel");
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

// --- #78: the gate must not be keyed on a platform-owned variable ---------
//
// `isProductionEnvironment()` was `process.env.VERCEL_ENV === "production"`.
// VERCEL_ENV is set only by Vercel, so a SELF-HOSTED deployment (README's
// `npm run build && npm start`, where NODE_ENV=production but VERCEL_ENV is
// unset) was treated as local development: the 500 refusal was skipped AND
// verifySignature() returned true for a missing secret, silently accepting
// unsigned, forgeable payloads.

describe("fail-closed signature enforcement off Vercel (#78)", () => {
  function createSignedRequest(payload: any, signature: string): NextRequest {
    const request: any = createRequest(payload);
    request.headers = new Headers({
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": signature,
    });
    return request as NextRequest;
  }

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
    // Baseline: generic host and no webhook secret configured.
    vi.stubEnv("DF_PLATFORM_PROVIDER", "generic");
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
    vi.stubEnv("GH_WEBHOOK_SECRET", "");
    vi.stubEnv("REQUIRE_WEBHOOK_SIGNATURE", undefined as unknown as string);
    vi.stubEnv("ALLOW_UNSIGNED_WEBHOOKS", undefined as unknown as string);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("REFUSES an unsigned webhook from a production build with no Vercel marker (self-hosted)", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).toBe(500);
    expect(res.data.ok).toBe(false);
    expect(res.data.error).toMatch(/refusing/i);
  });

  it("refuses it even when a signature header is present but no secret is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(
      createSignedRequest(PR_BODY, "sha256=deadbeef"),
    );

    // A signature cannot be verified without a secret, so this must never
    // fall through to 200.
    expect(res.status).toBe(500);
  });

  it("still allows unsigned webhooks on a Vercel preview build (evals preserved)", async () => {
    vi.stubEnv("DF_PLATFORM_PROVIDER", "vercel");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).not.toBe(500);
  });

  it("refuses an unknown platform provider instead of silently using a security mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DF_PLATFORM_PROVIDER", "unknown-platform");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).toBe(500);
    expect(res.data.error).toMatch(/DF_PLATFORM_PROVIDER/i);
  });

  it("does not let an explicit unsigned opt-out mask an invalid provider", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DF_PLATFORM_PROVIDER", "unknown-platform");
    vi.stubEnv("ALLOW_UNSIGNED_WEBHOOKS", "true");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).toBe(500);
    expect(res.data.error).toMatch(/DF_PLATFORM_PROVIDER/i);
  });

  it("requires a signature for an explicitly configured generic preview deployment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DF_DEPLOYMENT_ENV", "preview");
    vi.stubEnv("VERCEL_ENV", "preview");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).toBe(500);
    expect(res.data.error).toMatch(/signature/i);
  });

  it("still allows unsigned webhooks in local development", async () => {
    vi.stubEnv("NODE_ENV", "development");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).not.toBe(500);
  });

  it("honours an explicit opt-in on any environment, including preview", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("REQUIRE_WEBHOOK_SIGNATURE", "true");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).toBe(500);
  });

  it("honours an explicit opt-out on a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_UNSIGNED_WEBHOOKS", "true");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(createRequest(PR_BODY));

    expect(res.status).not.toBe(500);
  });

  it("still verifies a configured secret and rejects a bad signature", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GH_WEBHOOK_SECRET", "a-real-secret");

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(
      createSignedRequest(PR_BODY, "sha256=definitely-wrong"),
    );

    expect(res.status).toBe(401);
  });

  it("still ACCEPTS a correctly signed webhook on a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GH_WEBHOOK_SECRET", "a-real-secret");
    const crypto = await import("crypto");
    const body = JSON.stringify(PR_BODY);
    const good =
      "sha256=" +
      crypto.createHmac("sha256", "a-real-secret").update(body).digest("hex");
    const request: any = createRequest(PR_BODY);
    request.headers = new Headers({
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": good,
    });

    const { POST } = await import("../app/api/github/webhook/route");
    const res: any = await POST(request);

    // The whole point: hardening must not break correctly signed deliveries.
    expect(res.status).not.toBe(500);
    expect(res.status).not.toBe(401);
  });

  it("warns when the permissive path is taken, so a misconfiguration is visible", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { POST } = await import("../app/api/github/webhook/route");
    await POST(createRequest(PR_BODY));

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/unsigned|signature/i);
  });
});
