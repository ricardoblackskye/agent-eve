# 0020 — Cost governance is live on every LLM call, and a refusal is recorded on the run

- **Date:** 2026-10-08
- **Status:** Accepted

## Context

`cost-governor.ts` could already refuse a call and `governed-llm-call.ts` could wrap
one, but nothing called them on the paths that actually spend money: only the
orchestrator chat was gated (#217). The three subagents (product-owner,
release-manager, sprint-reporter) and the runner's Architect and Developer
`streamText` / `generateText` calls all ran **ungated**. A budget cap that covers one
of five call sites is not a cap.

Two forces shaped the choice. First, every call site builds its own provider client,
so a per-site wrapper would be duplicated five times and drift. Second, the
repository's toggle convention is a `DF_*_DRIVER` env var that is **off by default
and fails closed**; a boolean `ENABLE_*` flag is the anti-pattern, because its
default is open.

A refusal that is only logged is also invisible to the operator reading the ticket,
so the *reason* had to land somewhere durable and machine-readable.

## Decision

Cost governance is live on **every** LLM call, through shared seams rather than
per-site code:

- **`cost-gate.ts`** — a category-parameterized pre-call gate. A refusal **throws**,
  so a caller fails before the provider call. `orchestrator-gate.ts` becomes a thin
  wrapper (`category: "orchestrator"`), preserving its public shape.
- **`governed-model.ts`** — the shared `defineDynamic` resolver. Each subagent
  definition selects one of two **complete** branches (a static model with
  `modelContextWindowTokens`, or the gated dynamic resolver), because `defineAgent`
  requires an exact model-branch match.
- **`governed-agent-call.ts`** — the seam the runner's Architect/Developer call sites
  use. It wraps `runGovernedLlmCall`; on refusal it records the code and throws
  `CostRefusedError`.
- **`cost-refusal-recorder.ts`** plus a new optional `RunEvent.costRefusal` — the
  machine-readable `CostGovernorRefusal` code is appended to the run's event ledger
  (both SQLite and Postgres adapters, via idempotent `ensureSchema` ALTERs). Never
  free text.
- **`release-manager` stops using an unpriced `:free` model** and resolves the priced
  shared default: a model absent from the price table is always refused
  (`unpriced_model`), so the old exemption could not survive governance.

OPT-IN is preserved: with no budget backend configured the gate is `null` and the
governor absent, so every call runs exactly as before. A configured deployment fails
**closed**.

## Consequences

- A cap now bounds every path that spends money, and a run stopped by the cap says
  *why* on the ticket instead of only in a log.
- Five call sites share two seams, so a price-table or policy change lands once.
- Cost: the subagent definitions carry a two-branch shape (an awkward but load-bearing
  constraint of `defineAgent`), and a new call site must remember to route through a
  governed seam — the reviewer's test is "does this call site have a gate?".
- `unpriced_model` is now a real operator-visible failure mode: adding a model without
  a price entry breaks its calls, by design.