import { type NextRequest, NextResponse } from "next/server";
import { createPlatformAdapter } from "../../../../../agent/lib/dark-factory/platform";
import { resolveApiOrigin } from "../../../../../agent/lib/dark-factory/entry";

const API_KEY = process.env.EVE_API_KEY;
const platform = createPlatformAdapter();
const BYPASS_SECRET =
  platform.id === "vercel" ? process.env.VERCEL_PROTECTION_BYPASS : undefined;

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

  // SECURITY (SSRF, #304): never build the proxy target from the client-controlled
  // Host header. The origin is resolved fail-closed: a spoofed non-loopback Host must
  // not redirect this server-side fetch (which carries the Bearer token). When no
  // trusted origin can be resolved we fail closed with 502.
  const resolved = resolveApiOrigin(process.env, request.nextUrl.origin);
  if (!resolved.origin || !slug.startsWith("/eve/v1/")) {
    return NextResponse.json(
      {
        error:
          "Eve API origin could not be resolved from configuration; refusing the proxy.",
      },
      { status: 502 },
    );
  }
  const targetUrl = new URL(slug, resolved.origin);
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

  const bypass =
    platform.id === "vercel"
      ? BYPASS_SECRET ||
        request.headers.get("x-vercel-protection-bypass") ||
        request.nextUrl.searchParams.get("x-vercel-protection-bypass")
      : undefined;
  if (bypass) {
    headers["x-vercel-protection-bypass"] = bypass;
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
