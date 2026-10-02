# Docs: glossary, invariants and the ADR set (#237)

**Branch:** `feat/docs-domain-adrs-232e` (off `origin/main`)
**Epic:** #232 — Documentation enhancement (Release 3, leg 5 of 6)
**Closes:** #237

## Goal

Capture domain knowledge that **cannot** be derived from code — the vocabulary
and the *why* — so it is not lost as the application grows. #237's three pillars
are a glossary, an invariants page, and the ADR practice.

## What is already done (verified)

The "ADR set" half of #237 is **already complete** (landed via #239 and prior
work), so this leg does not recreate it:

- ADR index — `docs/adr/README.md` exists with a linked index.
- ADR template — `docs/adr/template.md` already exists.
- The 7 seeded decisions already exist as accepted ADRs: 0001 (tenant
  write-once), 0002 (R1 records / R2 refuses), 0003 (unmeasured never zero),
  0004 (fail-closed story publish), 0005 (SQLite local-only), 0006
  (provider-neutral seams), 0007 (control-state DB-backed fail-closed).

So #237's *remaining* work is purely: the **glossary page**, the **invariants
page**, and **documenting the DoD/process change** (that an ADR is part of each
release's Definition of Done).

## Intended fix (architecture)

Two new authored pages under `docs/pages/` plus a documentation addition:

- **`docs/pages/glossary.md`** — the private vocabulary. Defines every term used
  across the docs: PBI, tenant, run, dispatch, control plane, seam, adapter, gate,
  Dark Factory, R1/R2/R3, attribution, worker, circuit breaker, lease, optimistic
  concurrency, gated outcome, delivery/run/event IDs, provider, driver,
  fail-closed, dry-run, console provider. Each term links to the page/code that
  uses it. Authored as a single glossary, not re-stated per page (no duplication
  with `dark-factory.md` / the flow deep-dives).
- **`docs/pages/invariants.md`** — each invariant stated plainly, with its
  rationale and a link to the code that enforces it, and to the ADR that records
  the decision. Examples: write-once attribution (`run-attribution.ts`, ADR 0001),
  fail-closed story publish (`STORY_ALLOWED_REPOS`, ADR 0004), unmeasured ≠ 0
  (projection, ADR 0003), SQLite local-only (`run-history-sqlite.ts`, ADR 0005),
  provider-neutral seams + fail-closed default (ADR 0006), control-state DB-backed
  (ADR 0007), delivery-ID dedup (`dispatch.ts`), optimistic concurrency on control
  actions (`control.ts`), opaque non-routable lease issuance (`credentials.ts`).
- **`docs/adr/README.md`** — add a short "Part of the release Definition of
  Done" section stating that each release must record its decisions as ADRs at
  decision time (the process change #237 asks for), referencing the existing
  "When to write one" / "Rules" material.

The two pages are auto-listed by `app/documentation/page.tsx` (`listPages()` reads
`docs/pages/*.md`); I also add them to the `docs/pages/README.md` table of contents
for discoverability. No code change to the docs pipeline.

## TDD phases

- **RED** — `tests/docs-domain.test.ts`: glossary exists (> ~1000 chars) and
  contains the issue's required terms (PBI, tenant, run, dispatch, control plane,
  seam, adapter, gate, Dark Factory, R1, R2, R3); invariants exists (> ~1000
  chars) with ≥ 5 occurrences of "invariant" and at least one code link
  (`agent/lib/dark-factory/`, `app/api/dark-factory/`, `app/dark-factory/`,
  `app/auth-gate.ts`) and one ADR link; `docs/adr/README.md` contains
  "Definition of Done"; and the `docs/pages/README.md` TOC lists `glossary.md` and
  `invariants.md`. Fails before GREEN (pages absent, DoD section absent).
- **GREEN** — author `glossary.md` + `invariants.md`, add the DoD section, update
  the TOC.
- **REFACTOR** — ensure the glossary/invariants do not re-state mechanic detail
  already in `dark-factory.md`; they define terms and cite code, not re-explain.

## Files likely to change

- `docs/pages/glossary.md` (new)
- `docs/pages/invariants.md` (new)
- `docs/pages/README.md` (TOC)
- `docs/adr/README.md` (DoD section)
- `tests/docs-domain.test.ts` (new)

## Validation

- `npx vitest run tests/docs-domain.test.ts` (and full suite) — green.
- `npx tsc --noEmit --incremental false` — 0 errors.
- `npm run build` — the two pages render.
- `npx cspell@8` + `markdown-table-formatter` on changed files, including this plan.

## Risks / open questions

- **Completeness of the glossary.** Mitigation: the test pins the issue's required
  term list; I add the other terms the docs already use so the AC "every term used
  across the documentation appears in the glossary" holds for the current docs.
- **No dependency on the unmerged #236 flow pages.** This branch is based on
  `origin/main` (pre-#246). Glossary/invariants link to the existing
  `dark-factory.md`, code, and ADRs — not to the not-yet-merged flow pages — so no
  broken-link risk if #246 merges after this.
- **ADR template/index/seeded ADRs already present** (verified) — not recreated;
  #237's "ADR set" is satisfied by existing files, so no new ADR number is opened
  for this leg. The DoD documentation is added to the README, which is the
  documentation the AC asks for.
