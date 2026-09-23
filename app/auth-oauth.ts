import { timingSafeEqual } from "node:crypto";

/**
 * Pure OAuth 2.0 helpers for the Google flow (#99).
 *
 * Runs in Node route handlers only (NOT in the Edge `proxy.ts` gate): it uses
 * node:crypto for a timing-safe state comparison.
 */

export const GOOGLE_AUTH_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export async function createPkcePair(): Promise<PkcePair> {
  // 32 random bytes -> 43-char base64url verifier (RFC 7636 minimum).
  const verifier = base64Url(randomBytes(32));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function createState(): string {
  return base64Url(randomBytes(32));
}

export function validateState(
  cookieValue: string | null | undefined,
  queryState: string | null | undefined,
): boolean {
  if (!cookieValue || !queryState) return false;
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(queryState);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildGoogleAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope?: string;
  prompt?: string;
}): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", opts.scope ?? "openid email profile");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", opts.prompt ?? "select_account");
  return url.toString();
}
