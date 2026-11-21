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

## One sandbox per phase, and who releases it

A run holds **one sandbox at a time**, and the phase that creates it releases it.
[`runCodingPhase`](../../scripts/dark-factory-runner.ts) creates the workspace
tools, runs the phase and force-disposes the sandbox in a `finally` — so it goes on
success, on a thrown error and on an early return, without the phase doing anything.
The commit and the definition of done both sit **outside** that call, which means
the DoD never runs inside the coding sandbox.

`reapSandboxesByRun` is a second and weaker release: it runs at the *start* of a
run, only under the opensandbox driver, and reclaims a sandbox a create-time client
timeout left behind. It keys on the **run id**, so any sandbox a run opens later
must carry that same run id — one under any other id is invisible to the reaper and
becomes a leak with no safety net.

Two consequences worth knowing:

- A run resumed straight into its definition of done — the **verify-only re-entry**,
  taken when a run was waiting on checks that may since have settled — has **no
  sandbox at all**. It re-reads the checks and returns before the coding phase is
  reached: nothing was reaped, and nothing ever existed.
- A phase that must change code once the DoD has started therefore opens its **own**
  sandbox, on the pull request's own branch, under the same run id. It is authored
  and pushed from inside it, and prepared *before* the branch is committed to, since
  `commitAndPushFromSandbox` resets the branch to the current HEAD. The reasoning is
  in [a fix pass runs in its own sandbox](../../docs/adr/0093-a-fix-pass-runs-in-its-own-sandbox.md).

## Honest limits

No live container isolation is exercised without an E2B/Modal key, so the default
provider is a dry-run that never claims otherwise. The e2b/modal adapters plug
into the same seam once credentials exist, and the credential source can be
swapped to a GitHub App installation token without changing the broker's API.

The cost side of a worker run (how many minutes/cycles it burned) is covered in
[cost and usage governance](flow-cost-governance.md); the loop that re-dispatches a
failed run is in the [run lifecycle](flow-run-lifecycle.md).
