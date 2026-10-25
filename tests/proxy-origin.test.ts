import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// #471 regression: the auth gate must send the browser to the host it actually asked for. Before the fix,
// proxy.ts built its Location from request.nextUrl.origin, which is the address the dev server is bound to.
// A server bound to 127.0.0.1 answering a request made to 127.0.0.1:3001 therefore redirected to
// localhost:3001; the host-only session cookie did not survive the hop and the chain restarted.
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

// A valid-looking secret makes resolveSessionSecret return a value; verifySessionToken is stubbed to
// "no session", so the gate takes its redirect branch without doing real jose work.
vi.mock("../app/auth-config", () => ({
  resolveSessionSecret: () => "test-secret",
}));
vi.mock("../app/auth-session", () => ({
  SESSION_COOKIE_NAME: "eve_session",
  verifySessionToken: vi.fn(async () => null),
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

describe("auth gate redirect names the client's host (#471)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("redirects to the Host header the client used, not the server's bind address", async () => {
    const { proxy } = await import("../proxy");
    // Server believes it lives on localhost:3000; the client actually asked for 127.0.0.1:3001.
    await proxy(createRequest("/documentation/overview", "http://localhost:3000", "127.0.0.1:3001"));

    expect(redirect).toHaveBeenCalledTimes(1);
    const location = String(redirect.mock.calls[0][0]);
    expect(location).toContain("http://127.0.0.1:3001/api/auth/google/start");
    expect(location).not.toContain("localhost:3000");
  });

  it("carries the original path and query into the next= parameter", async () => {
    const { proxy } = await import("../proxy");
    await proxy(createRequest("/chat?thread=42", "http://localhost:3000", "127.0.0.1:3001"));

    const location = String(redirect.mock.calls[0][0]);
    expect(location).toContain(
      "next=" + encodeURIComponent("/chat?thread=42"),
    );
  });

  it("prefers a proxy-supplied forwarded host over Host", async () => {
    const { proxy } = await import("../proxy");
    const request = createRequest(
      "/documentation/overview",
      "http://localhost:3000",
      "internal-service:3000",
    );
    (request.headers as Headers).set("x-forwarded-host", "eve.example.com");
    (request.headers as Headers).set("x-forwarded-proto", "https");

    await proxy(request);

    expect(String(redirect.mock.calls[0][0])).toContain(
      "https://eve.example.com/api/auth/google/start",
    );
  });

  it("lets a session through without redirecting", async () => {
    vi.resetModules();
    vi.doMock("../app/auth-session", () => ({
      SESSION_COOKIE_NAME: "eve_session",
      verifySessionToken: vi.fn(async () => ({ email: "someone@example.com" })),
    }));
    const { proxy } = await import("../proxy");
    await proxy(
      createRequest("/documentation/overview", "http://localhost:3000", "127.0.0.1:3001"),
    );
    expect(redirect).not.toHaveBeenCalled();
  });
});
