# Architecture Decision Records

An ADR captures **one decision** so a future developer never has to re-derive it.
The *why* is the part of a system that code cannot express, and the part most
readily lost as an application grows.

## When to write one

Write an ADR when a change:

- introduces, rejects, or swaps a vendor, seam, adapter, or external contract;
- makes an irreversible or write-once data decision;
- sets a fail-closed vs fail-open posture, or an opt-in vs on-by-default default;
- deliberately defers work, where the reason matters more than the deferral;
- deviates from the obvious approach on purpose.

**Trigger test:** *"Will a competent developer, six months from now, ask 'why is it
like this?'"* If yes, write it. If the code already answers it, skip it — a record
that merely restates the code is noise.

## Format

Copy [`template.md`](template.md). One decision per file, about half a page:

- **Context** — the forces in play.
- **Decision** — what we chose, in the active voice.
- **Consequences** — what this makes easy, hard, or impossible.

## Rules

- **Location and naming:** `docs/adr/NNNN-<slug>.md`, numbered sequentially,
  zero-padded (`0001-tenant-attribution-is-write-once.md`).
- **Immutable once accepted.** Never edit an accepted record. If the decision
  changes, write a NEW ADR that supersedes it and set the old one's status to
  `Superseded by NNNN`. Keep the superseded file — the record of *why we changed
  our mind* is itself valuable.
- **Write it at decision time**, in the same change that makes the decision.
  A retrospective ADR is a reconstruction and loses the real trade-offs.
- **Every record is linked below.** An orphan ADR is invisible;
  `tests/adr-integrity.test.ts` fails on one.

## Part of the release Definition of Done

Writing an ADR for each decision a release makes is part of that release's
Definition of Done (introduced by #237). An ADR written at the moment of deciding
is nearly free; a retrospective one is a reconstruction that loses the real
trade-offs. For every release/PR: the plan file lists the ADRs the change will
add; new decisions land as ADRs in the same change that makes them; and each
accepted ADR is linked from this index (an orphan fails
`tests/adr-integrity.test.ts`). Never edit an accepted ADR — if the decision
changes, write a new one that supersedes it.

## Index

| #                                                                 | Decision                                                         | Status   |
|-------------------------------------------------------------------|------------------------------------------------------------------|----------|
| [0001](0001-tenant-attribution-is-write-once.md)                  | Tenant attribution is write-once                                 | Accepted |
| [0002](0002-r1-records-r2-refuses.md)                             | R1 records and reports; R2 refuses                               | Accepted |
| [0003](0003-unmeasured-is-never-zero.md)                          | An unmeasured value is never zero                                | Accepted |
| [0004](0004-story-publish-is-fail-closed.md)                      | Story publish is fail-closed                                     | Accepted |
| [0005](0005-sqlite-is-local-only.md)                              | SQLite is local-only                                             | Accepted |
| [0006](0006-provider-neutral-seams.md)                            | Provider-neutral seams                                           | Accepted |
| [0007](0007-control-state-is-db-backed.md)                        | Control state is DB-backed and fail-closed                       | Accepted |
| [0008](0008-tenant-registry-is-ours-crm-is-bought.md)             | The tenant registry is ours; the CRM is bought                   | Accepted |
| [0009](0009-tailwind-adopted-repo-wide.md)                        | Tailwind is adopted repo-wide, as the single styling method      | Accepted |
| [0010](0010-documentation-is-a-docs-tree.md)                      | Documentation is a docs/ tree served by server components        | Accepted |
| [0011](0011-eve-is-pinned-and-upgrades-are-deliberate.md)         | eve is pinned; upgrades are not absorbed into dependency bumps   | Accepted |
| [0012](0012-docs-reference-pages-are-generated-at-render-time.md) | Docs reference pages are generated at render time, not committed | Accepted |
| [0013](0013-test-data-is-seeded-through-the-store-seam.md)        | Test data is seeded through the store seam                       | Accepted |
| [0014](0014-tenant-budgets-are-a-dimension-of-the-store.md)       | Tenant budgets are a dimension of the existing budget store      | Accepted |
| [0015](0015-unprovisioned-tenant-is-refused-not-provisioned.md)   | An unprovisioned tenant is refused, never auto-provisioned       | Accepted |
| [0016](0016-membership-is-resolved-per-request.md)                | Membership is resolved per request, not carried in the claim     | Accepted |
| [0017](0017-tenant-scope-is-derived-server-side.md)               | Tenant scope is derived server-side and enforced at the route    | Accepted |
