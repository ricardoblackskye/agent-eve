# Worker sandbox and credential boundary

The factory's hardest safety rule: **give the worker hands without giving the
sandbox a key to the building.** This page describes what a worker sandbox may
hold, what it must never hold, and how the boundary is enforced by construction.

## What the worker may hold: a lease, not a token

[`credentials.ts`](../../agent/lib/dark-factory/credentials.ts) defines a
`CredentialBroker` that holds the operator's real token and issues the worker an
**opaque lease** — a repo allow-list plus a TTL of at most 60 minutes. The sandbox
receives the lease ID and nothing else. The token is a real ECMAScript `#private`
field, so it is unreachable by property enumeration or `JSON.stringify`; the
worker literally cannot read it.

Lease **adjudication** answers `200` / `403` / `401` over real HTTP
(`POST /authorize`, loopback-bound). Critically, lease **issuance is not
routable** — a sandbox must never be able to mint its own credential. This is why
"MUST NOT deliver a broad PAT to any worker sandbox" holds by construction, not by
convention.

## What the worker must never hold

- The operator PAT (it is `#private` to the broker; see above).
- A repo outside `DF_WORKER_ALLOWED_REPOS` — refused **before** provisioning, with
  no side effects ([ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md):
  R2 refuses).
- Any credential that outlives its lease; revocation is tied to environment
  teardown.

## The lifecycle owns the boundary

[`worker-env.ts`](../../agent/lib/dark-factory/worker-env.ts) implements the
`WorkerProvider` seam (`provision → pushContext → exec → destroy`). `withWorker`
refuses an out-of-allow-list repo *before* provisioning, pushes the skeletal file
map and PBI data before anything runs, and tears the environment down on **every**
path — success, thrown error, or failed context push — revoking the lease
alongside it. The default `local` provider reports `isolated: false` and executes
nothing; it never claims isolation it does not have.

## Honest limits

No live container isolation is exercised without an E2B/Modal key, so the default
provider is a dry-run that never claims otherwise. The e2b/modal adapters plug
into the same seam once credentials exist, and the credential source can be
swapped to a GitHub App installation token without changing the broker's API.

The cost side of a worker run (how many minutes/cycles it burned) is covered in
[cost and usage governance](flow-cost-governance.md); the loop that re-dispatches a
failed run is in the [run lifecycle](flow-run-lifecycle.md).
