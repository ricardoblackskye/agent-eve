import { NextResponse, type NextRequest } from "next/server";
import { OAuth2Client } from "google-auth-library";
import {
  buildRedirectUri,
  resolveAllowedEmails,
  resolveSessionSecret,
} from "../../../../auth-config";
import { validateState } from "../../../../auth-oauth";
import { decideCallback } from "../../../../auth-callback";
import { verifyGoogleChatAccess } from "../../../../google-auth";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  sessionCookieOptions,
} from "../../../../auth-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "eve_oauth_state";
const VERIFIER_COOKIE = "eve_oauth_verifier";

/**
 * Step 2 of the Google flow (#99): validate `state`, exchange the code, verify
 * the ID token server-side, apply the allow-list, and only then mint the
 * session cookie. Every failure path lands on /unauthorized.
 */
export async function GET(request: NextRequest) {
  const env = process.env;
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const stateParam = params.get("state");

  const rawStateCookie = request.cookies.get(STATE_COOKIE)?.value ?? "";
  const [stateValue, encodedNext = ""] = rawStateCookie.split("|");
  const next = encodedNext ? decodeURIComponent(encodedNext) : "/";

  const denied = () =>
    clearTransient(
      NextResponse.redirect(
        new URL("/unauthorized", request.nextUrl.origin),
        302,
      ),
    );

  if (!code || !validateState(stateValue, stateParam)) {
    console.warn(
      "[auth] Google callback rejected: missing code or state mismatch",
    );
    return denied();
  }

  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const secret = resolveSessionSecret(env);
  if (!clientId || !clientSecret || !secret) {
    return clearTransient(
      NextResponse.json(
        { error: "Google OAuth is not fully configured." },
        { status: 500 },
      ),
    );
  }

  try {
    const client = new OAuth2Client({
      clientId,
      clientSecret,
      redirectUri: buildRedirectUri(env, request.nextUrl.origin),
    });
    const codeVerifier = request.cookies.get(VERIFIER_COOKIE)?.value;
    const { tokens } = await client.getToken({ code, codeVerifier });
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token ?? "",
      audience: clientId,
    });
    const payload = ticket.getPayload();

    const verification = verifyGoogleChatAccess(
      { email: payload?.email, verifiedEmail: payload?.email_verified },
      resolveAllowedEmails(env),
    );
    const decision = decideCallback(verification, next);

    if (!decision.allowed) {
      console.warn(
        `[auth] Google sign-in denied: ${decision.reason ?? "unknown"}`,
      );
      return denied();
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
      sessionCookieOptions({ secure: env.NODE_ENV === "production" }),
    );
    console.log("[auth] Google sign-in granted");
    return clearTransient(response);
  } catch (error) {
    console.warn(
      `[auth] Google callback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return denied();
  }
}

function clearTransient<T extends NextResponse>(response: T): T {
  response.cookies.delete(STATE_COOKIE);
  response.cookies.delete(VERIFIER_COOKIE);
  return response;
}
