/**
 * Build a redirect Location that can never leave `origin`.
 *
 * `decideCallback` already constrains `redirectTo` through `safeNextPath`, so in
 * practice it is always a same-origin path. This guard sits at the redirect site
 * as defense-in-depth: if that upstream constraint is ever relaxed or bypassed, an
 * absolute or protocol-relative `redirectTo` would otherwise let `new URL` ignore
 * the base and emit an off-origin `Location`. We fail closed to the origin root.
 */
export function safeRedirect(origin: string, redirectTo: string): string {
  const target = new URL(redirectTo, origin);
  if (target.origin !== origin) {
    return new URL("/", origin).toString();
  }
  return target.toString();
}
