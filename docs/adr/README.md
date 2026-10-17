# Architecture Decision Records

An ADR captures **one decision** so a future developer never has to re-derive it.
The _why_ is the part of a system that code cannot express, and the part most
readily lost as an application grows.

## When to write one

Write an ADR when a change:

- introduces, rejects, or swaps a vendor, seam, adapter, or external contract;
- makes an irreversible or write-once data decision;
- sets a fail-closed vs fail-open posture, or an opt-in vs on-by-default default;
- deliberately defers work, where the reason matters more than the deferral;
- deviates from the obvious approach on purpose.

**Trigger test:** _"Will a competent developer, six months from now, ask 'why is it
like this?'"_ If yes, write it. If the code already answers it, skip it — a record
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
  `Superseded by NNNN`. Keep the superseded file — the record of _why we changed
  our mind_ is itself valuable.
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

| #                                                                 | Decision                                                                                | Status   |
|-------------------------------------------------------------------|-----------------------------------------------------------------------------------------|----------|
| [0001](0001-tenant-attribution-is-write-once.md)                  | Tenant attribution is write-once                                                        | Accepted |
| [0002](0002-r1-records-r2-refuses.md)                             | R1 records and reports; R2 refuses                                                      | Accepted |
| [0003](0003-unmeasured-is-never-zero.md)                          | An unmeasured value is never zero                                                       | Accepted |
| [0004](0004-story-publish-is-fail-closed.md)                      | Story publish is fail-closed                                                            | Accepted |
| [0005](0005-sqlite-is-local-only.md)                              | SQLite is local-only                                                                    | Accepted |
| [0006](0006-provider-neutral-seams.md)                            | Provider-neutral seams                                                                  | Accepted |
| [0007](0007-control-state-is-db-backed.md)                        | Control state is DB-backed and fail-closed                                              | Accepted |
| [0008](0008-tenant-registry-is-ours-crm-is-bought.md)             | The tenant registry is ours; the CRM is bought                                          | Accepted |
| [0009](0009-tailwind-adopted-repo-wide.md)                        | Tailwind is adopted repo-wide, as the single styling method                             | Accepted |
| [0010](0010-documentation-is-a-docs-tree.md)                      | Documentation is a docs/ tree served by server components                               | Accepted |
| [0011](0011-eve-is-pinned-and-upgrades-are-deliberate.md)         | eve is pinned; upgrades are not absorbed into dependency bumps                          | Accepted |
| [0012](0012-docs-reference-pages-are-generated-at-render-time.md) | Docs reference pages are generated at render time, not committed                        | Accepted |
| [0013](0013-test-data-is-seeded-through-the-store-seam.md)        | Test data is seeded through the store seam                                              | Accepted |
| [0014](0014-tenant-budgets-are-a-dimension-of-the-store.md)       | Tenant budgets are a dimension of the existing budget store                             | Accepted |
| [0015](0015-unprovisioned-tenant-is-refused-not-provisioned.md)   | An unprovisioned tenant is refused, never auto-provisioned                              | Accepted |
| [0016](0016-membership-is-resolved-per-request.md)                | Membership is resolved per request, not carried in the claim                            | Accepted |
| [0017](0017-tenant-scope-is-derived-server-side.md)               | Tenant scope is derived server-side and enforced at the route                           | Accepted |
| [0018](0018-comment-reference-in-ledger.md)                       | Store a comment reference, not the question text, in the ledger                         | Accepted |
| [0019](0019-orchestration-handler-pipeline.md)                    | The orchestration handler sequences the factory pipeline                                | Accepted |
| [0020](0020-cost-governance-is-live-on-every-llm-call.md)         | Cost governance is live on every LLM call; a refusal is recorded on the run             | Accepted |
| [0021](0021-terminal-labels-fail-closed.md)                       | Terminal lifecycle labels are applied by a fail-closed finalizer                        | Accepted |
| [0022](0022-comment-answer-resumes-a-parked-run.md)               | A comment answer resumes a parked run; the answer reaches the factory as DATA           | Accepted |
| [0023](0023-retry-is-a-new-run-abort-is-terminal.md)              | Retry starts a new run; abort is terminal where stop is a flag                          | Accepted |
| [0024](0024-record-the-trip-on-the-run.md)                        | A circuit-breaker trip is recorded on the run; the breaker stamps the cap it hit        | Accepted |
| [0025](0025-filter-child-process-environments.md)                 | A shared allow-list filters the env handed to a child process                           | Accepted |
| [0026](0026-atomic-active-run-claim.md)                           | An active-run claim is atomic: one active run per repo+issue                            | Accepted |
| [0027](0027-model-prices-are-reservation-ceilings.md)             | Model prices are reservation ceilings, not exact rates                                  | Accepted |
| [0028](0028-df-sandbox-execution-seam.md)                         | The sandbox execution backend is a fail-closed, configuration-selected seam             | Accepted |
| [0029](0029-df-code-author-seam.md)                               | The code author is a fail-closed, configuration-selected seam                           | Accepted |
| [0030](0030-df-llm-gateway.md)                                    | Sandbox model calls are governed at an in-repo gateway                                  | Accepted |
| [0031](0031-df-runner-consumes-author-seam.md)                    | The runner consumes the code-author seam (fail-closed)                                  | Accepted |
| [0032](0032-df-sandbox-lifecycle-owned-by-runner.md)              | Sandbox lifecycle is the runner's responsibility, force-disposed                        | Accepted |
| [0033](0033-df-gateway-spend-is-run-history-event.md)             | Sandbox spend is a first-class run-history event                                        | Accepted |
| [0034](0034-df-sandbox-reaping-by-run-id.md)                      | Sandbox reaping is keyed by run id (defense in depth)                                   | Accepted |
| [0035](0035-df-sandbox-credential-vault.md)                       | Sandbox credentials live in a write-only vault; leases opaque, egress deny-by-default   | Accepted |
| [0036](0036-df-sandbox-vault-push-wiring.md)                      | Vault push is fail-closed and runs inside the sandbox whose image carries the project   | Accepted |
| [0037](0037-df-target-repo-resolution.md)                         | A run's target repository is resolved from config and authorized by an allow-list       | Accepted |
| [0038](0038-per-repo-factory-settings-in-config.md)               | Per-repo Factory settings live in config, not the database                              | Accepted |
| [0039](0039-df-sandbox-push-trusts-egress-ca.md)                  | The in-sandbox push trusts the egress sidecar's CA and never disables verification      | Accepted |
| [0040](0040-df-run-failure-is-terminal.md)                        | Any post-acceptance failure ends the run terminally, so a failure cannot hold its claim | Accepted |
| [0041](0041-df-plan-approval-is-opt-in.md)                        | A plan is approved only by explicit approval wording                                    | Accepted |
| [0042](0042-df-plan-revision-needs-approval.md)                   | A plan revision re-parks, is capped, and the deployed path holds rather than coding     | Accepted |
