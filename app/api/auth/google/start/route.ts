import { NextResponse, type NextRequest } from "next/server";
import {
  buildRedirectUri,
  CALLBACK_PATH,
  isDevAuthEnabled,
  DEFAULT_ALLOWED_EMAIL,
} from "../../../../auth-config";
import {
  buildGoogleAuthUrl,
  createPkcePair,
  createState,
} from "../../../../auth-oauth";
import { safeNextPath } from "../../../../auth-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "eve_oauth_state";
const VERIFIER_COOKIE = "eve_oauth_verifier";

/**
 * Step 1 of the Google flow (#99): mint `state` + PKCE, remember them in
 * short-lived HttpOnly cookies, and bounce the browser to Google's consent
 * screen. Nothing is authenticated until the callback verifies.
 */
export async function GET(request: NextRequest) {
  const env = process.env;
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    // Local/e2e: no real Google credentials — fall back to the dev sign-in
    // helper (itself fail-closed; it refuses in production).
    if (isDevAuthEnabled(env)) {
      const dev = new URL("/api/auth/dev", request.nextUrl.origin);
      dev.searchParams.set(
        "email",
        env.ALLOWED_GOOGLE_EMAIL || DEFAULT_ALLOWED_EMAIL,
      );
      dev.searchParams.set("next", next);
      return NextResponse.redirect(dev, 302);
    }
    return NextResponse.json(
      {
        error:
          "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      },
      { status: 500 },
    );
  }

  const state = createState();
  const { verifier, challenge } = await createPkcePair();
  const redirectUri = buildRedirectUri(env, request.nextUrl.origin);

  const response = NextResponse.redirect(
    buildGoogleAuthUrl({
      clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
    }),
    302,
  );
  const secure = env.NODE_ENV === "production";
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: 600, // 10 minutes to complete the round-trip
  };
  response.cookies.set(
    STATE_COOKIE,
    `${state}|${encodeURIComponent(next)}`,
    cookieOptions,
  );
  response.cookies.set(VERIFIER_COOKIE, verifier, cookieOptions);

  console.log(`[auth] Google sign-in started -> ${CALLBACK_PATH}`);
  return response;
}
