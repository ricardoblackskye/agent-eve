import { eveChannel } from "eve/channels/eve";
import {
  extractBearerToken,
  localDev,
  UnauthenticatedError,
  vercelOidc,
} from "eve/channels/auth";
import type { SessionAuthContext } from "eve/context";

/**
 * Custom bearer-token auth that checks the `Authorization` header against
 * an `EVE_API_KEY` environment variable.
 *
 * - With a matching token: accepts the request as a service principal.
 * - With a mismatched token: returns a 401.
 * - With no `EVE_API_KEY` configured: skips (falls through to next entry),
 *   so deployments that forget the env var still get a meaningful error
 *   rather than silently accepting everything.
 */
const bearerAuth = (request: Request): SessionAuthContext | null => {
  const expectedKey = process.env.EVE_API_KEY;

  // No key configured — skip, let the next auth entry (or default 401) handle it
  if (!expectedKey) {
    return null;
  }

  const authHeader = request.headers.get("authorization");
  const token = extractBearerToken(authHeader);

  if (token === expectedKey) {
    return {
      attributes: {},
      authenticator: "bearer-token",
      principalId: "eve-api-user",
      principalType: "service",
    };
  }

  // Mismatched or missing token — reject with 401
  throw new UnauthenticatedError({
    code: "unauthorized",
    message:
      "Invalid or missing API key. Set the Authorization header to Bearer <EVE_API_KEY>.",
  });
};

export default eveChannel({
  auth: [
    // Lets the Vercel platform reach the deployed agent via OIDC.
    vercelOidc(),
    // Opens on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // Custom bearer-token auth. Accepts requests with a valid EVE_API_KEY.
    bearerAuth,
  ],
});