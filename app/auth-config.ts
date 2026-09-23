/**
 * Env/config resolution for the Google auth flow (#99). Pure + injectable so
 * every branch is unit-testable without touching process.env.
 */

export const DEFAULT_ALLOWED_EMAIL = "cuillinguy@gmail.com";

export const CALLBACK_PATH = "/api/auth/google/callback";

export interface AuthEnv {
  AUTH_DEV_MODE?: string;
  NODE_ENV?: string;
  ALLOWED_GOOGLE_EMAIL?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  AUTH_SESSION_SECRET?: string;
}

const TRUTHY = ["1", "true", "yes", "on"];

function isTruthy(value: string | undefined): boolean {
  return !!value && TRUTHY.includes(value.trim().toLowerCase());
}

export function isProduction(env: AuthEnv): boolean {
  return env.NODE_ENV === "production";
}

/**
 * Dev mode mints sessions without Google. FAIL-CLOSED: it is refused whenever
 * NODE_ENV is "production", so a stray AUTH_DEV_MODE=1 on a deploy cannot open
 * the chat to the world.
 */
export function isDevAuthEnabled(env: AuthEnv): boolean {
  return isTruthy(env.AUTH_DEV_MODE) && !isProduction(env);
}

/** The allow-list (AC: hardcoded email, env-overridable, default @default). */
export function resolveAllowedEmails(env: AuthEnv): string[] {
  const raw = (env.ALLOWED_GOOGLE_EMAIL ?? "").trim();
  if (!raw) return [DEFAULT_ALLOWED_EMAIL];
  return raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/** Dev-only fallback so AUTH_DEV_MODE works without configuring a secret. */
export const DEV_SESSION_SECRET = "dev-only-insecure-session-secret";

/**
 * The session signing secret. In production this MUST come from the env; the
 * dev fallback is returned only when dev mode is active (itself refused in
 * production), so a deploy can never sign sessions with the dev constant.
 */
export function resolveSessionSecret(env: AuthEnv): string | null {
  const secret = (env.AUTH_SESSION_SECRET ?? "").trim();
  if (secret) return secret;
  if (isDevAuthEnabled(env)) return DEV_SESSION_SECRET;
  return null;
}

export function buildRedirectUri(env: AuthEnv, requestOrigin: string): string {
  const configured = (env.GOOGLE_REDIRECT_URI ?? "").trim();
  if (configured) return configured;
  return new URL(CALLBACK_PATH, requestOrigin).toString();
}
