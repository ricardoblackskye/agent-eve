import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// #471: the dev sign-in redirect must name the host the client used. Before the fix, dev/route.ts built
// its Location from request.nextUrl.origin, which is the dev server's bind address. A server bound to
// 127.0.0.1 answering a request made to 127.0.0.1:3001 therefore redirected to localhost:3001; the
// host-only session cookie did not survive the hop and the auth chain restarted.
const redirect = vi.fn((url: URL | string, status?: number) => ({
  status: status ?? 302,
  location: String(url),
  cookies: { set: vi.fn(), delete: vi.fn() },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => ({ kind: "next" })),
    json: vi.fn((body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      body,
    })),
    redirect,
  },
}));

vi.mock("../app/auth-config", () => ({
  isDevAuthEnabled: () => true,
  resolveAllowedEmails: () => ["allowed@example.com"],
  resolveSessionSecret: () => "test-secret",
}));
vi.mock("../app/google-auth", () => ({
  verifyGoogleChatAccess: () => ({ allowed: true, email: "allowed@example.com" }),
}));
vi.mock("../app/auth-session", () => ({
  SESSION_COOKIE_NAME: "eve_session",
  createSessionToken: vi.fn(async () => "token"),
  sessionCookieOptions: () => ({}),
}));
vi.mock("../app/auth-callback", () => ({
  decideCallback: () => ({ allowed: true, email: "allowed@example.com", redirectTo: "/documentation/overview" }),
}));
vi.mock("../app/auth-gate", () => ({
  safeNextPath: (next: string | null) => next ?? "/",
}));

function createRequest(
  path: string,
  nextUrlOrigin: string,
  hostHeader: string,
): NextRequest {
  const nextUrl = new URL(path, nextUrlOrigin);
  return {
    nextUrl,
    method: "GET",
    headers: new Headers({ host: hostHeader }),
    cookies: { get: () => undefined },
    url: nextUrl.toString(),
  } as unknown as NextRequest;
}

describe("dev sign-in redirect names the client's host (#471)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("redirects to the Host header the client used, not the server's bind address", async () => {
    const { GET } = await import("../app/api/auth/dev/route");
    await GET(
      createRequest(
        "/api/auth/dev?email=allowed@example.com&next=/documentation/overview",
        "http://localhost:3000",
        "127.0.0.1:3001",
      ),
    );

    expect(redirect).toHaveBeenCalledTimes(1);
    const location = String(redirect.mock.calls[0][0]);
    expect(location).toContain("http://127.0.0.1:3001/documentation/overview");
    expect(location).not.toContain("localhost:3000");
  });

  it("prefers a proxy-supplied forwarded host over Host", async () => {
    const { GET } = await import("../app/api/auth/dev/route");
    const request = createRequest(
      "/api/auth/dev?email=allowed@example.com&next=/documentation/overview",
      "http://localhost:3000",
      "internal-service:3000",
    );
    (request.headers as Headers).set("x-forwarded-host", "eve.example.com");
    (request.headers as Headers).set("x-forwarded-proto", "https");

    await GET(request);

    expect(String(redirect.mock.calls[0][0])).toContain(
      "https://eve.example.com/documentation/overview",
    );
  });
});
