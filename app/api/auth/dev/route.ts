import { NextResponse, type NextRequest } from "next/server";
import {
  isDevAuthEnabled,
  resolveAllowedEmails,
  resolveSessionSecret,
} from "../../../auth-config";
import { verifyGoogleChatAccess } from "../../../google-auth";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  sessionCookieOptions,
} from "../../../auth-session";
import { decideCallback } from "../../../auth-callback";
import { safeNextPath } from "../../../auth-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dev/e2e sign-in (#99) — mints a session for a given email WITHOUT Google so
 * the flow can be exercised locally and in Playwright.
 *
 * FAIL-CLOSED: 404s unless AUTH_DEV_MODE is on and NODE_ENV is not production.
 * It runs the same allow-list check as the real callback, so the denial path is
 * genuinely exercised too.
 */
export async function GET(request: NextRequest) {
  const env = process.env;

  if (!isDevAuthEnabled(env)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const email = (request.nextUrl.searchParams.get("email") ?? "")
    .trim()
    .toLowerCase();
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));
  const verification = verifyGoogleChatAccess(
    { email, verifiedEmail: true },
    resolveAllowedEmails(env),
  );
  const decision = decideCallback(verification, next);

  if (!decision.allowed) {
    return NextResponse.redirect(
      new URL("/unauthorized", request.nextUrl.origin),
      302,
    );
  }

  const secret = resolveSessionSecret(env);
  if (!secret) {
    return NextResponse.json(
      { error: "No session secret available." },
      { status: 500 },
    );
  }

  const token = await createSessionToken({
    email: decision.email as string,
    secret,
  });
  const response = NextResponse.redirect(
    new URL(decision.redirectTo, request.nextUrl.origin),
    302,
  );
  response.cookies.set(
    SESSION_COOKIE_NAME,
    token,
    sessionCookieOptions({ secure: false }),
  );
  console.log(`[auth] dev sign-in granted for ${decision.email}`);
  return response;
}
