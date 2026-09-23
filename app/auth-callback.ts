import type { AuthVerificationResult } from "./google-auth";
import { safeNextPath } from "./auth-gate";

/** Where the callback sends the browser after Google returns (#99). */
export interface CallbackDecision {
  allowed: boolean;
  redirectTo: string;
  email?: string;
  reason?: string;
}

export function decideCallback(
  verification: AuthVerificationResult,
  nextPath: string,
): CallbackDecision {
  if (verification.allowed) {
    return {
      allowed: true,
      redirectTo: safeNextPath(nextPath),
      email: verification.email,
    };
  }
  return {
    allowed: false,
    redirectTo: "/unauthorized",
    reason: verification.reason,
  };
}
