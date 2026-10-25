import { describe, it, expect, vi, beforeEach } from "vitest";

// #304: the Eve proxy must NOT build its server-side fetch target from the
// client-controlled Host header. Before the fix, `new URL(slug, request.nextUrl.origin)`
// let a spoofed Host redirect the fetch (SSRF). RED anchors the required behavior.

const fetchMock = vi.fn();

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn(
      (body: unknown, init?: { status?: number }) =>
        ({ status: init?.status ?? 200, body }) as any,
    ),
  },
}));

import { POST } from "../app/api/eve/v1/[...slug]/route";

function makeRequest(opts: {
  host: string;
  path?: string;
  method?: string;
}): any {
  const headers = new Headers({ host: opts.host });
  const url = new URL(
    `http://${opts.host}${opts.path ?? "/api/eve/v1/session/proj1"}`,
  );
  return {
    method: opts.method ?? "POST",
    headers,
    nextUrl: url,
    blob: async () => new Blob([]),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    status: 200,
    statusText: "OK",
    headers: { get: () => "application/json" },
    json: async () => ({ ok: true }),
  } as any);
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.DF_API_BASE_URL;
  delete process.env.VERCEL_URL;
  delete process.env.EVE_API_KEY;
});

describe("Eve proxy origin resolution (#304)", () => {
  it("refuses a spoofed non-loopback Host with 502 and never fetches it", async () => {
    const res = await POST(makeRequest({ host: "evil.example.com" }) as any);
    expect(res.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes to the configured DF_API_BASE_URL regardless of the Host header", async () => {
    process.env.DF_API_BASE_URL = "https://api.internal.example.com";
    const res = await POST(makeRequest({ host: "evil.example.com" }) as any);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target] = fetchMock.mock.calls[0];
    expect(String(target)).toBe(
      "https://api.internal.example.com/eve/v1/session/proj1",
    );
  });

  it("trusts a loopback Host in local dev when nothing is configured", async () => {
    const res = await POST(makeRequest({ host: "127.0.0.1:3000" }) as any);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target] = fetchMock.mock.calls[0];
    expect(String(target)).toBe("http://127.0.0.1:3000/eve/v1/session/proj1");
  });
});
