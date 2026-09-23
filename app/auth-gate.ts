/**
 * Which requests the Google session gate protects (#99). Pure so the policy is
 * unit-tested rather than buried in `proxy.ts`.
 *
 * Default is FAIL-CLOSED: anything not explicitly public is protected, so a new
 * page is gated by default rather than accidentally exposed.
 */

const PUBLIC_EXACT = ["/unauthorized", "/favicon.ico", "/robots.txt"];

/**
 * Public by design:
 * - `/api/auth/*`      the OAuth flow itself (chicken/egg) + signout
 * - `/api/github/webhook` server-to-server, has its own signature check (Dark Factory)
 * - `/eve/*`           the Eve runtime itself (own auth); `/api/eve/*` rewrites
 *                      to it server-side WITHOUT forwarding cookies, and CI
 *                      health-checks `/eve/v1/health`, so it must stay public
 * - `/api/eve/*`       the Eve proxy keeps its own Bearer auth (server callers
 *                      and the browser send the same key, so it cannot be
 *                      re-gated here without breaking the eval/DF bearer flow)
 * - `/_next/*`         build output
 */
const PUBLIC_PREFIXES = [
  "/api/auth",
  "/api/github/webhook",
  "/_next",
  "/api/eve",
  "/eve",
];

export function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export function isProtectedPath(pathname: string): boolean {
  if (PUBLIC_EXACT.includes(pathname)) return false;
  if (
    PUBLIC_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return false;
  }
  // Static assets (any path with a file extension) are public.
  if (/\.[a-z0-9]+$/i.test(pathname)) return false;
  return true;
}

/**
 * Only ever return a same-site path — stops the `?next=` parameter becoming an
 * open redirect. Rejects protocol-relative (`//evil.com`), absolute and
 * backslash (Windows-exploit) forms.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  const value = raw.trim();
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  if (value.includes("\\")) return "/";
  return value;
}
