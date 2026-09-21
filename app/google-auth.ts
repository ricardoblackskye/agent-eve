/**
 * Google Authentication & Access Control for Eve Chat (#97).
 *
 * Scope:
 * - Authenticate users with Google before allowing Eve Chat UI access.
 * - Enforce approved user allow-list: currently restricted strictly to cuillinguy@gmail.com.
 */

export const ALLOWED_GOOGLE_USERS = ["cuillinguy@gmail.com"] as const;

export interface GoogleUserProfile {
  email: string;
  name?: string;
  picture?: string;
  verifiedEmail?: boolean;
}

export interface GoogleAuthVerificationResult {
  authorized: boolean;
  email?: string;
  reason?: string;
}

/**
 * Validates whether an authenticated Google user is authorized to access Eve Chat.
 */
export function verifyGoogleChatAccess(
  profile: GoogleUserProfile | null | undefined,
): GoogleAuthVerificationResult {
  if (!profile || !profile.email) {
    return {
      authorized: false,
      reason: "No Google user profile or email provided.",
    };
  }

  const normalizedEmail = profile.email.trim().toLowerCase();
  const isAllowed = ALLOWED_GOOGLE_USERS.includes(
    normalizedEmail as (typeof ALLOWED_GOOGLE_USERS)[number],
  );

  if (!isAllowed) {
    return {
      authorized: false,
      email: normalizedEmail,
      reason: `User '${normalizedEmail}' is not authorized to access Eve Chat.`,
    };
  }

  return {
    authorized: true,
    email: normalizedEmail,
  };
}
