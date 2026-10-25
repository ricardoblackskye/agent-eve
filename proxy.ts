import { NextResponse, type NextRequest } from "next/server";
import { isApiPath, isProtectedPath } from "./app/auth-gate";
import { SESSION_COOKIE_NAME, verifySessionToken } from "./app/auth-session";
import { resolveSessionSecret } from "./app/auth-config";
import { resolveRequestOrigin } from "./app/request-origin";

/**
 * The Google auth gate (#99). Next 16 renamed `middleware.ts` -> `proxy.ts`.
 *
 * Verifies the signed session cookie locally (jose, Edge-safe) — no network, no
 * DB, so the ≤50ms NFR holds. Anything protected without a valid session is
 * redirected to Google (pages) or 401'd (API).
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!isProtectedPath(pathname)) return NextResponse.next();

  const secret = resolveSessionSecret(process.env);
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = secret ? await verifySessionToken(token, { secret }) : null;
  if (session) return NextResponse.next();

  if (isApiPath(pathname)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // #471: name the host the CLIENT used. nextUrl.origin is the server's bind address, so a server bound
  // to 127.0.0.1 would answer a request made to 127.0.0.1:3001 with a Location on localhost:3001 - and
  // the host-only session cookie does not survive that hop.
  const start = new URL("/api/auth/google/start", resolveRequestOrigin(request));
  start.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(start, 302);
}

export const config = {
  // Run on everything except build output and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
