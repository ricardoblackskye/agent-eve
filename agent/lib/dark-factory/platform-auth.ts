import type { PlatformProviderId } from "./platform";

/**
 * Select the optional platform authenticator while preserving common auth order.
 *
 * The Vercel authenticator factory is lazy so a generic deployment neither
 * constructs nor depends on Vercel OIDC behavior.
 */
export function selectPlatformAuth<T>(
  providerId: PlatformProviderId,
  vercelAuth: () => T,
  commonAuth: T[],
): T[] {
  return providerId === "vercel"
    ? [vercelAuth(), ...commonAuth]
    : [...commonAuth];
}
