/**
 * Build the Authorization header the chat UI sends to the /api/eve proxy.
 *
 * The proxy (app/api/eve/v1/[...slug]/route.ts) requires
 * `Authorization: Bearer <EVE_API_KEY>`. The browser cannot hold the secret
 * EVE_API_KEY, so it uses the public counterpart NEXT_PUBLIC_EVE_API_KEY, which
 * must be set to the same value in the deployment (see issue #42).
 */
export function getEveChatHeaders(): Record<string, string> {
  const key = process.env.NEXT_PUBLIC_EVE_API_KEY;
  return key ? { authorization: `Bearer ${key}` } : {};
}
