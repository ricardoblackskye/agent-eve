# Plan — #329 (DF P2b): tenancy isolation — prove the seam and the two edges

**Branch:** `fix/df-tenancy-seam-329`
**Issue:** [#329](https://github.com/ricardoblackskye/agent-eve/issues/329) (child of #276)

## Premise corrected during recon

This issue's first draft claimed tenancy isolation was "built and wired but **unproven by any test**".
That was wrong. Verified before writing any test:

| layer       | test                                                  | what it already proves                                                                                                                 |
| ----------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| query       | `run-scope.test.ts`                                   | fail-closed (customer with no tenant), operator sees all including unattributed, tenant scoping, foreign run → 404, aggregates refused |
| route       | `run-query-api.test.ts` (drives the **real** handler) | customer scoping with a foreign `run-theirs` present, by-id 404, `/metrics` 403 for a customer                                         |
| concurrency | `cost-budget-store-postgres.test.ts`                  | simultaneous reservations cannot oversubscribe one cap (real Postgres, `FOR UPDATE`); runs in CI since #325                            |

The route tests also carry **non-vacuity**: they swap a mocked `resolveViewer`'s resolution, so a route
that ignored the viewer and defaulted to operator would fail them.

## The three gaps that are actually unproven

1. **The seam between the two halves.** `run-query-api.test.ts` **mocks** `resolveViewer`
   (`vi.mock("../../app/api/dark-factory/viewer")`), and `viewer.test.ts` tests `resolveViewer` in
   isolation. **Nothing drives the real chain** — session → membership store → `tenantId` → route →
   scoped result — so cross-tenant invisibility currently rests on a stub whose object shape agrees
   with production by convention, not by proof.
2. **The scope-fill bound.** `MAX_SCOPE_FILL_PAGES = 10` (`run-query.ts`): a customer's list walks up
   to 10 store pages to fill one page, because other tenants' runs interleave. Untested: that a
   customer is never shown a foreign run (nor loses their own) when the interleaving exceeds a page,
   and that the walk terminates.
3. **Non-existence confirmation.** `queryRunDetail` returns 404 for an out-of-scope run precisely so
   the response never confirms that another tenant's run exists (`run-query.ts:330`). No test asserts
   that the two 404s are actually **indistinguishable**.

## Tasks (RED → GREEN)

**T1 (RED) — the end-to-end seam.** Drive the **real** route `GET` with a real session cookie and a real
membership store holding two tenants plus an operator. No mock of the viewer.

- a customer's list contains only their own runs, with a foreign run present in the store;
- by-id on a foreign run → 404;
- an **unattributed** run is invisible to a customer and visible to an operator;
- the operator's list contains everything.

**T2 (RED) — scope-fill.** More than one page (default 25) of interleaved foreign runs ahead of the
customer's own: assert the returned page holds only their runs, the walk stays within
`MAX_SCOPE_FILL_PAGES`, and a sparse result is handled.

**T3 (RED) — the two 404s must be identical.** The response for a foreign run's id and for a never-existing id
are identical in status and body — no distinct message, no echoed `runId`.

**T4 (GREEN)** — fix whatever T1–T3 expose, **in code** (never by relaxing a test). If they expose
nothing, the honest outcome is a merged verification PR with no production change.

**T5 — non-vacuity.** Disconnect the viewer from the route (force an operator scope) → T1 must **fail**.
Restore → pass. Both runs recorded as evidence.

## Files

- `agent/lib/dark-factory/run-query.ts` — `isRunVisible`, `MAX_SCOPE_FILL_PAGES`, the 404 decision.
- `app/api/dark-factory/runs/route.ts`, `app/api/dark-factory/runs/[runId]/route.ts` — viewer wiring.
- `app/api/dark-factory/viewer.ts` — `resolveViewer`.
- `agent/lib/dark-factory/membership-store*.ts` — the two-tenant fixture.
- `tests/dark-factory/run-query-api.test.ts` — the mocked-viewer harness this plan sits beside.

## Verification

Full suite · Postgres suites against a **real** database · `tsc` · cspell · `npm run build`.
**Non-vacuity:** T5.

## Out of scope

Tenant billing / CRM (#222 series) · cross-tenant admin tooling.
