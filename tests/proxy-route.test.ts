import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

// Mock NextResponse from next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data: any, init?: any) => ({
      status: init?.status ?? 200,
      body: JSON.stringify(data),
    })),
  },
}));

function createRequest(path: string): NextRequest {
  const url = new URL(path, "http://localhost:3000");
  return {
    nextUrl: url,
    method: "GET" as const,
    headers: new Headers({ "content-type": "application/json" }),
    blob: vi.fn().mockResolvedValue(new Blob()),
    // NextRequest properties we don't use but TypeScript requires
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
    json: vi.fn(),
    text: vi.fn(),
    bytes: vi.fn(),
  } as unknown as NextRequest;
}

describe("proxy route - bypass header", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.VERCEL_PROTECTION_BYPASS;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("includes x-vercel-protection-bypass header when VERCEL_PROTECTION_BYPASS is set", async () => {
    process.env.VERCEL_PROTECTION_BYPASS = "my-bypass-secret";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("../app/api/eve/v1/[...slug]/route");
    const request = createRequest("/api/eve/v1/health");
    await GET(request);

    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall).toBeDefined();
    const [, options] = fetchCall;
    expect(options.headers).toHaveProperty(
      "x-vercel-protection-bypass",
      "my-bypass-secret"
    );
  });

  it("omits x-vercel-protection-bypass header when env var is not set", async () => {
    delete process.env.VERCEL_PROTECTION_BYPASS;

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("../app/api/eve/v1/[...slug]/route");
    const request = createRequest("/api/eve/v1/health");
    await GET(request);

    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall).toBeDefined();
    const [, options] = fetchCall;
    expect(options.headers).not.toHaveProperty("x-vercel-protection-bypass");
  });

  it("omits bypass header when VERCEL_PROTECTION_BYPASS is empty string", async () => {
    process.env.VERCEL_PROTECTION_BYPASS = "";

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("{}", {
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { GET } = await import("../app/api/eve/v1/[...slug]/route");
    const request = createRequest("/api/eve/v1/health");
    await GET(request);

    const fetchCall = fetchMock.mock.calls[0];
    expect(fetchCall).toBeDefined();
    const [, options] = fetchCall;
    expect(options.headers).not.toHaveProperty("x-vercel-protection-bypass");
  });
});