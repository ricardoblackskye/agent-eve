import {
  SESSION_COOKIE_NAME,
  verifySessionToken,
  type SessionPayload,
} from "../../auth-session";
import { resolveSessionSecret } from "../../auth-config";

/** Parse a single cookie by name from a Cookie header value. */
export function readCookieValue(
  cookieHeader: string | null,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/**
 * Resolve the viewer session signing secret from the deployment environment.
 * Returns null (authenticated requests will be denied) when no secret is
 * configured and dev mode is not active — fail-closed in production.
 */
export async function resolveViewerSecret(): Promise<string | null> {
  return resolveSessionSecret({
    AUTH_SESSION_SECRET: process.env.AUTH_SESSION_SECRET,
    AUTH_DEV_MODE: process.env.AUTH_DEV_MODE,
    NODE_ENV: process.env.NODE_ENV,
  });
}

/**
 * Verify the signed `eve_session` cookie for an incoming request. Returns the
 * session payload only when a secret is configured and the token is valid;
 * any missing, malformed, or expired token is treated as unauthenticated.
 */
export async function getViewerSession(
  request: Request,
): Promise<SessionPayload | null> {
  const secret = await resolveViewerSecret();
  if (!secret) return null;
  const token = readCookieValue(
    request.headers.get("cookie"),
    SESSION_COOKIE_NAME,
  );
  return verifySessionToken(token, { secret });
}
