# 0005 — SQLite is local-only

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

Each store seam supports `console`, `sqlite`, and `postgres` drivers. A Vercel
function filesystem is ephemeral, so SQLite in a deployed environment would
silently lose state between requests while appearing to work locally.

## Decision

Reject SQLite when `NODE_ENV=production` or when the deployment stage is preview
or production. Production persistence requires a real external adapter.

## Consequences

- Local development and CI get a genuine external-state store, which is enough to
  prove real semantics without a database server.
- A misconfigured production deployment fails loudly at startup instead of losing
  data quietly.
- Any new store seam must implement a real adapter before it can be used in
  production — SQLite is never the production answer.
