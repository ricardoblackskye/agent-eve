import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock NextResponse from next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((data: any, init?: any) => ({
      status: init?.status ?? 200,
      body: JSON.stringify(data),
    })),
  },
}));

function createRequest(path: string) {
  const url = new URL(path, "http://localhost:3000");
  return {
    nextUrl: url,
    method: "GET",
    headers: new Headers({ "content-type": "application/json" }),
    blob: vi.fn(),
  };
}

describe("proxy route - bypass header", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
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