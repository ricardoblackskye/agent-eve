import { type NextRequest, NextResponse } from "next/server";

const API_KEY = process.env.EVE_API_KEY;
const BYPASS_SECRET = process.env.VERCEL_PROTECTION_BYPASS;

async function handler(request: NextRequest) {
  // Health endpoint is always accessible without authentication.
  const isHealthPath = request.nextUrl.pathname.endsWith("/health");

  // Validate authorization when EVE_API_KEY is configured.
  // Requests without a valid Bearer token are rejected with 401.
  // Health checks are exempt.
  if (API_KEY && !isHealthPath) {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      return NextResponse.json(
        { error: "Unauthorized: invalid or missing API key" },
        { status: 401 },
      );
    }
  }

  // Rewrite /api/eve/v1/* → /eve/v1/* (same-origin via withEve)
  const slug = request.nextUrl.pathname.replace("/api/eve", "/eve");
  const targetUrl = new URL(slug, request.nextUrl.origin);
  targetUrl.search = request.nextUrl.search;

  const headers: Record<string, string> = {};

  // Only add authorization when EVE_API_KEY is set; in local dev the Eve
  // dev server accepts unauthenticated requests via localDev() auth.
  if (API_KEY) {
    headers.authorization = `Bearer ${API_KEY}`;
  }

  // Copy relevant headers from the original request
  const contentType = request.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  const accept = request.headers.get("accept");
  if (accept) headers["accept"] = accept;

  if (BYPASS_SECRET) {
    headers["x-vercel-protection-bypass"] = BYPASS_SECRET;
  }

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.blob();

  // Determine if this is a stream endpoint
  const isStreamPath = /^\/eve\/v1\/session\/[^/]+\/stream/.test(slug);

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body,
  });

  // For stream endpoints, pipe the response body as-is
  if (isStreamPath) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "text/event-stream",
      },
    });
  }

  // For regular endpoints, return JSON
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
