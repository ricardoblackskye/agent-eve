import crypto from "crypto";

/**
 * Helpers for exercising the GitHub webhook from an eval.
 *
 * Production rejects unsigned webhook payloads with 401 by design (see the
 * signature enforcement in app/api/github/webhook/route.ts). The production
 * eval suite therefore has to sign its requests the same way GitHub does:
 * `sha256=HMAC_SHA256(secret, rawBody)` in the `x-hub-signature-256` header.
 *
 * When no secret is configured (local `eve eval`, CI without the secret) these
 * helpers let the eval skip the happy-path assertions instead of asserting the
 * old insecure behaviour.
 */

export function signingSecret(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const secret = env.GH_WEBHOOK_SECRET;
  return secret ? secret : undefined;
}

export function canSign(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(signingSecret(env));
}

export function signPayload(body: string, secret: string): string {
  return (
    "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex")
  );
}
