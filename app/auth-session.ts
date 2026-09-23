import { SignJWT, jwtVerify } from "jose";

/**
 * Signed session cookie for the Eve Chat Google auth flow (#99).
 *
 * Tokens are HS256 JWTs (jose) so the same verify call works in Next 16's
 * Edge-runtime `proxy.ts` AND in Node route handlers — no `google-auth-library`
 * (Node-only) in the request gate.
 *
 * No database: the cookie is the session (the issue requires no approved-user
 * lookup).
 */

export interface SessionPayload {
  /** Normalised (lower-cased, trimmed) Google account email. */
  email: string;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export const SESSION_COOKIE_NAME = "eve_session";

/** 8 hours — see the plan's "session TTL" decision. */
export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

export function sessionCookieOptions(opts: {
  secure: boolean;
  maxAgeSeconds?: number;
}): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: opts.secure,
    path: "/",
    maxAge: opts.maxAgeSeconds ?? DEFAULT_SESSION_TTL_MS / 1000,
  };
}

export async function createSessionToken(opts: {
  email: string;
  secret: string;
  now?: number;
  ttlMs?: number;
}): Promise<string> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const iat = Math.floor(now / 1000);
  const exp = Math.floor((now + ttlMs) / 1000);

  return await new SignJWT({ email: opts.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(opts.secret));
}

export async function verifySessionToken(
  token: string | null | undefined,
  opts: { secret: string; now?: number },
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(opts.secret),
      {
        // Pin the clock so expiry is deterministic in tests.
        currentDate: new Date(opts.now ?? Date.now()),
      },
    );
    const email = typeof payload.email === "string" ? payload.email : "";
    if (!email) return null;
    return {
      email,
      iat: typeof payload.iat === "number" ? payload.iat : 0,
      exp: typeof payload.exp === "number" ? payload.exp : 0,
    };
  } catch {
    // Bad signature, expired, malformed — all mean "not authenticated".
    return null;
  }
}
