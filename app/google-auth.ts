export const ALLOWED_GOOGLE_USERS = ["cuillinguy@gmail.com"];

export interface GoogleUserProfile {
  email?: string;
  name?: string;
  verifiedEmail?: boolean;
  picture?: string;
}

export interface AuthVerificationResult {
  allowed: boolean;
  reason?: string;
  email?: string;
}

export function verifyGoogleChatAccess(profile?: GoogleUserProfile | null): AuthVerificationResult {
  if (!profile) {
    return { allowed: false, reason: "Missing profile" };
  }

  if (!profile.email || !profile.email.trim()) {
    return { allowed: false, reason: "Missing email" };
  }

  if (profile.verifiedEmail !== true) {
    return { allowed: false, reason: "Email not verified" };
  }

  const normalizedEmail = profile.email.toLowerCase().trim();
  const isAllowed = ALLOWED_GOOGLE_USERS.includes(normalizedEmail);

  if (isAllowed) {
    return { allowed: true, email: normalizedEmail };
  }

  return { allowed: false, reason: "Unauthorized email" };
}