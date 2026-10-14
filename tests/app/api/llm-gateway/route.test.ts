import { describe, expect, it, vi, beforeAll } from "vitest";
import { NextRequest } from "next/server";

describe("llm-gateway route (R3/T4)", () => {
  beforeAll(() => {
    // Configure the gateway so a bad token is refused (not "not_configured"), exercising the 401 path.
    process.env.OPENROUTER_API_KEY = "sk-test-gateway";
    process.env.DF_LLM_GATEWAY_MODELS = "gpt-4o";
  });

  it("returns exactly one generic 401 and never leaks lease state", async () => {
    const { POST } = await import("../../../../app/api/llm-gateway/route");
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as never;
    const req = new NextRequest("http://localhost/api/llm-gateway", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer bad-token",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unauthorized");
    expect(body).not.toHaveProperty("reason");
  });

  it("DELETE of an absent lease returns 404 (idempotent success-as-404)", async () => {
    const { DELETE } = await import("../../../../app/api/llm-gateway/route");
    const req = new NextRequest(
      "http://localhost/api/llm-gateway?token=does-not-exist",
      { method: "DELETE" },
    );
    const res = await DELETE(req);
    expect(res.status).toBe(404);
  });
});
