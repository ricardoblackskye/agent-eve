/**
 * Which host did the client actually use? (#471)
 *
 * `request.nextUrl.origin` answers with the address the SERVER is bound to, not the address the client
 * typed. A dev server bound to `127.0.0.1` therefore answers a request made to `127.0.0.1:3001` with a
 * `Location` on `localhost:3001`; a server bound to `0.0.0.0` answers with `0.0.0.0`. Because
 * `sessionCookieOptions` sets no `domain`, the session cookie is host-only, so a redirect that crosses
 * hosts drops it and the auth gate restarts the chain - the 50-redirect loop behind #471.
 *
 * Resolution order, most authoritative first:
 *   1. `x-forwarded-host` (+ `x-forwarded-proto`, defaulting to https) - a proxy knows the outside address.
 *   2. `Host` - a direct connection knows its own address.
 *   3. `nextUrl.origin` - last resort, which is also the old behaviour when no header is present.
 *
 * A header is untrusted input, so the authority is validated before it becomes a `Location`: hostname or
 * bracketed IPv6, optional port, and nothing else. Anything carrying CR, LF, whitespace, `@`, a path, a
 * query or a fragment is refused and the next candidate is tried. That keeps a hostile header from
 * injecting a header or steering the redirect off-origin.
 */

export type RequestOriginInput = {
  headers: { get(name: string): string | null };
  nextUrl: { origin: string };
};

// hostname labels, or a bracketed IPv6 literal, then an optional port.
const HOSTNAME = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?`;
const HOSTNAME_RE = new RegExp(
  String.raw`^(?:${HOSTNAME}(?:\.${HOSTNAME})*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$`,
);

const ALLOWED_PROTOCOLS = new Set(["http", "https"]);

/** True when `value` is a bare authority we are willing to put in a Location. */
export function isSafeAuthority(value: string): boolean {
  return HOSTNAME_RE.test(value);
}

function firstHeaderValue(value: string | null): string {
  // A proxy may append to x-forwarded-*: "client, proxy1, proxy2". The leftmost is the client's.
  return (value ?? "").split(",")[0].trim();
}

export function resolveRequestOrigin(request: RequestOriginInput): string {
  const forwardedHost = firstHeaderValue(
    request.headers.get("x-forwarded-host"),
  );
  const rawProto = firstHeaderValue(
    request.headers.get("x-forwarded-proto"),
  ).toLowerCase();
  // A forwarded pair is only as trustworthy as BOTH halves. An absent proto means "the proxy did not
  // say", so https is the safe assumption; a proto that is present but nonsense means the chain is
  // malformed or hostile, so the whole forwarded pair is discarded and Host is consulted instead.
  const protoUsable = rawProto === "" || ALLOWED_PROTOCOLS.has(rawProto);
  if (forwardedHost && isSafeAuthority(forwardedHost) && protoUsable) {
    const protocol = ALLOWED_PROTOCOLS.has(rawProto) ? rawProto : "https";
    return `${protocol}://${forwardedHost}`;
  }

  const host = firstHeaderValue(request.headers.get("host"));
  if (host && isSafeAuthority(host)) {
    // Take the protocol from the server's own origin: it is the only signal we have, and it keeps a
    // plain-http dev server working while a TLS-terminating deployment still reports https.
    const protocol = protocolOf(request.nextUrl.origin);
    return `${protocol}://${host}`;
  }

  return request.nextUrl.origin;
}

function protocolOf(origin: string): string {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(origin);
  const protocol = (match?.[1] ?? "http").toLowerCase();
  return ALLOWED_PROTOCOLS.has(protocol) ? protocol : "http";
}
