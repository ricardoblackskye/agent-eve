# 0016 — Membership is resolved per request, not carried in the session claim

- Date: 2026-10-05
- Status: Accepted

## Context
The Dark Factory session cookie (`eve_session`) is an HS256 JWT that carries an
email and nothing else. Customer access (#215) needs a role and, for a customer,
a tenant. The tempting shortcut is to widen the claim: put the role and tenant in
the cookie at sign-in and read them from the token on every request. That makes
revocation depend on the cookie's lifetime — suspending an account, moving a user
to another tenant, or demoting an operator would take effect only when the token
expires, and the token is signed with a long TTL.

## Decision
The claim stays minimal: email, issued-at, expiry. The role and tenant are read
from the membership store on EVERY request by `resolveViewer`, which refuses when
there is no session, no membership, or an inactive membership. Nothing about scope
is cached in the cookie or in process memory.

## Consequences
- A suspension, a scope change or a removal takes effect on the next request.
- Every guarded request costs one membership read; the store is the single source
  of scope, so a stale cookie cannot grant stale access.
- The membership store must be reachable for any Dark Factory read to succeed — an
  unreadable store is a 403, not an empty scope.