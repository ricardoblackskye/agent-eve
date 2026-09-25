import { NextResponse } from "next/server";

/** All Dark Factory read responses are private and must not be cached. */
export const NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
} as const;

export function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "Authentication required" },
    { status: 401, headers: NO_STORE_HEADERS },
  );
}

export function badRequest(error: string): NextResponse {
  return NextResponse.json(
    { error },
    { status: 400, headers: NO_STORE_HEADERS },
  );
}

export function notFound(error = "Run not found"): NextResponse {
  return NextResponse.json(
    { error },
    { status: 404, headers: NO_STORE_HEADERS },
  );
}

export function serviceUnavailable(): NextResponse {
  return NextResponse.json(
    { error: "Run history is unavailable" },
    { status: 503, headers: NO_STORE_HEADERS },
  );
}

export function okJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: NO_STORE_HEADERS });
}
