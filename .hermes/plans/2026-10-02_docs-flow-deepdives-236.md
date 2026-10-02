# Docs: author the Dark Factory flow deep-dives (#236)

**Branch:** `feat/docs-flow-deepdives-232d` (off `origin/main`)
**Epic:** #232 — Documentation enhancement (Release 2, leg 4 of 6)
**Closes:** #236

## Goal

Author six flow deep-dive pages a developer needs to understand **how the Dark Factory
fits together** — the epic's "key logic areas" — as narrative walkthroughs, better than
reading the README or the mechanic catalog.

## Root cause / why now

#234 gave us a docs tree and #235 (leg 3) made the *mechanical* reference
self-generating. But the existing `docs/pages/dark-factory.md` is a **mechanic catalog**
(per-seam files, fields, env knobs), not a **flow** narrative. A new developer still
cannot follow "a run from acceptance to outcome" from one place. #236's six areas —
run lifecycle, control plane, worker sandbox, cost governance, tenant attribution,
observability — need flow walkthroughs that *describe the flow, not just the files* and
link to both the code and the ADR that explains *why*.

## Intended fix (architecture)

Six new **authored** pages in `docs/pages/`, named with a `flow-*` prefix so they are
distinct from the existing `flows.md` (request/auth) and the mechanic `dark-factory.md`:

- `flow-run-lifecycle.md` — acceptance → attribution → dispatch → worker → self-correction
  → outcome, as a single narrative a new dev can follow end to end.
- `flow-control-plane.md` — control state, drivers (`DF_*_DRIVER`), gated outcomes,
  optimistic concurrency.
- `flow-worker-sandbox.md` — what the worker may hold (lease id) and must not (the
  operator PAT), and the fail-closed refusal before provisioning.
- `flow-cost-governance.md` — policy, ledger, budgets, reserve/settle; **links** to the
  #214 legs rather than re-deriving them.
- `flow-tenant-attribution.md` — write-once attribution and *why* (links to the leg-5
  ADRs).
- `flow-observability.md` — metrics, run history (#198), run query API (#199), progress
  board (#200).

Each page is a **flow narrative** that *links* to `dark-factory.md` for mechanics and to
the related ADRs and code — it does **not** re-describe the per-file mechanics (that is
`dark-factory.md`'s job and the leg-3 generated reference). The acceptance criterion "no
page duplicates a generated reference page — link instead" is honoured by linking to
`/documentation/<slug>` for the mechanical tables.

The six pages are picked up automatically by `app/documentation/page.tsx`
(`listPages()` reads `docs/pages/*.md`), so they appear in the rendered index with no code
change there. The hand-maintained `docs/pages/README.md` table of contents is updated to
list them.

## TDD phases

- **RED** — `tests/docs-deepdives.test.ts`: for each of the six expected slugs, assert
  the file exists in `docs/pages/`, is non-trivial (> ~800 chars), and contains at least
  one ADR link (`](...adr...)` / `adr/00NN`) and at least one code link (a path under
  `agent/lib/dark-factory/`, `app/api/dark-factory/`, or `app/lib/`). Also assert the
  `docs/pages/README.md` TOC lists each slug. The test fails (files absent / links
  missing) before GREEN. Commit the RED test.
- **GREEN** — author the six pages so the test passes; update `README.md` TOC.
- **REFACTOR** — where a flow page would re-state a mechanic already in
  `dark-factory.md`, replace the prose with a link to that section + the code/ADR, keeping
  the two artefacts complementary, not duplicated.

## Files likely to change

- `docs/pages/flow-run-lifecycle.md` (new)
- `docs/pages/flow-control-plane.md` (new)
- `docs/pages/flow-worker-sandbox.md` (new)
- `docs/pages/flow-cost-governance.md` (new)
- `docs/pages/flow-tenant-attribution.md` (new)
- `docs/pages/flow-observability.md` (new)
- `docs/pages/README.md` (TOC update)
- `tests/docs-deepdives.test.ts` (new)

## Validation

- `npx vitest run tests/docs-deepdives.test.ts` (and the full suite) — green.
- `npx tsc --noEmit --incremental false` — 0 errors.
- `npm run build` — succeeds; the six pages render.
- `npx cspell@8` + `markdown-table-formatter` on changed files, including this plan.

## Risks / open questions

- **Duplication with `dark-factory.md`.** Mitigation: the flow pages are narratives that
  *link* to the mechanic catalog and the leg-3 generated reference, not re-describe them.
  The RED test only checks existence/links, so the REFACTOR step is where duplication is
  actively pruned.
- **#235 not yet merged.** This branch is based on `origin/main` (pre-#235). Where a flow
  page links to a leg-3 generated page (`/documentation/api-routes` etc.), that link
  resolves only after #245 merges; both are Release 2 and will land together.
- **Tenant attribution / cost governance reference #214 legs** that are still open
  (#214, #215). The pages describe the *shape* and link to those issues/ADRs rather than
  asserting implementation that does not exist yet.

## ADRs

No new ADR is required — the pages link to existing decisions (e.g. #0004 story-publish
fail-closed, #0001 tenant attribution write-once, #0011 eve pin, #0012 generated-docs). A
new ADR is added only if authoring surfaces a decision not yet recorded.
