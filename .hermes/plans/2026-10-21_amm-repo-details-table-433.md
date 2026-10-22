# AMM Repo Details — readiness as a table (#433) Implementation Plan

**Goal:** On the repository detail page (`/dark-factory/repos/<owner>/<name>`) render the AMM readiness scan as a properly formatted table instead of the current nested bullet list.

**Architecture:** `AmmScale` stays a presentational, data-driven component — it holds no pillar names, metric set or point values of its own; it renders whatever a scan contains. The change is markup plus one declared CSS class; the scan contract and the `AmmReadinessProvider` seam are untouched.

**Tech stack:** Next.js App Router client component, React, Vitest + Testing Library (jsdom), plain CSS in `app/globals.css`.

---

## Current behaviour (verified)

- `app/dark-factory/repos/[owner]/[name]/page.tsx` renders `<AmmScale repo={repo} scan={scan} />`, where `scan` comes from `defaultAmmProvider()` (the fixture today; the real scanner is a separate concern, not this issue).
- `app/dark-factory/ui/amm-scale.tsx` renders the readiness as a nested list: a `<ul class="df-amm-pillars">` of pillars, each `<li class="df-amm-pillar">` carrying an `<h3>` name, a level `<span class="df-pill">`, an optional benchmark `<p>`, a `<ul class="df-amm-signals">` of signal bullets, and a joined evidence line. A separate `Autonomous processes` list follows.
- Signal bullets carry the DOM hooks the tests query: `data-signal={signal.id}` and `data-present={signal.present ? "yes" : "no"}`.
- Types (`agent/lib/dark-factory/amm-readiness.ts`):
  - `AmmSignal { id, label, present, level, state?: "present" | "absent" | "unmeasured" }`
  - `AmmPillar { id, name, level, label, benchmark, evidence: readonly string[], signals?: AmmSignal[] }`
  - `AmmScan { repo, scannedAt, overall, pillars, capabilities }`
- Tests that constrain the change:
  - `tests/dark-factory-ui/amm-scale.test.tsx` — level/points subtitle, metric-set independence (nothing hard-coded), production floor, per-signal present/absent hooks, and the "no scan yet" state.
  - `tests/dark-factory-ui/repo-detail-page.test.tsx` — asserts the page hosts the readiness scale (`level 4 (optimized)` visible via a heading lookup for the repo name).
  - `tests/dark-factory-ui/style-contract.test.ts` — every `df-*-table` class a component uses MUST have a rule in `app/globals.css`.
- No e2e spec references AMM readiness (checked `e2e/*.ts`).

## Intended change

Replace the pillar/signal bullet markup with a table:

- A `<table className="df-amm-table">` with a `<caption>` summarizing the overall level and points, a header row, and one row per signal grouped under its pillar.
- **Columns:** Pillar · Signal · Level · Result.
  - **Pillar** — the pillar name, rendered as a `rowspan` group cell over its signals (so a pillar with no signals still appears as a single row).
  - **Signal** — `signal.label`.
  - **Level** — `L{signal.level}` (small, muted).
  - **Result** — `Present` / `Absent` / `Not measured`, derived from `signal.state ?? (signal.present ? "present" : "absent")`.
- A pillar's `benchmark` and `evidence` render as a muted caption row spanning the table beneath that pillar's signal rows, so no information is lost.
- The existing DOM hooks are preserved on each signal row: `data-signal={signal.id}` and `data-present={present ? "yes" : "no"}` — plus a new `data-state` for the three-state value.
- `Autonomous processes` (the capabilities list) is **out of scope** and stays exactly as it is.

### The three-state result (why it is in scope)

The scan already carries `state?: "present" | "absent" | "unmeasured"` (#382), and the repository's standing rule is *"unmeasured is never zero, and never absent"* — a column that collapsed "nobody looked" into "failed" would violate it. The table shows three distinct results. `data-present` keeps its current meaning (unmeasured is not present), so existing assertions stand.

## Task list (TDD)

### Task 1 — RED: the scan renders as a table with a header and a row per signal

**Objective:** assert the table structure and the column headers.

**Files:**
- Modify: `tests/dark-factory-ui/amm-scale.test.tsx`

**Step 1:** add a test that renders a fixture scan with two signals and asserts:
- `screen.getByRole("table")` exists
- the header cells read `Pillar`, `Signal`, `Level`, `Result`
- each signal has a row found by its hook (`container.querySelector('[data-signal="linter"]')` is a `tr`)
- every existing assertion in the file still passes unchanged

**Step 2:** run `npx vitest run tests/dark-factory-ui/amm-scale.test.tsx` — expected FAIL because no `<table>` is rendered yet (the current markup is a list).

**Step 3:** commit `test(433): RED — the readiness scan renders as a table, not a list`.

### Task 2 — GREEN: render the table

**Objective:** restructure `AmmScale` from nested lists to the table above.

**Files:**
- Modify: `app/dark-factory/ui/amm-scale.tsx`

**Step 4:** build the table from `scan.pillars` (no hard-coded names); keep the overall subtitle, the `Level {AMM_FLOOR_LEVEL}` floor note and the "no readiness scan yet" branch byte-for-byte in meaning.

**Step 5:** run the focused test — expected PASS. Then run the full suite for regressions.

**Step 6:** commit `feat(433): GREEN — the readiness scan renders as a table`.

### Task 3 — RED/GREEN: the three-state result column

**Objective:** an unmeasured signal is distinguishable from an absent one.

**Files:**
- Modify: `tests/dark-factory-ui/amm-scale.test.tsx`, `app/dark-factory/ui/amm-scale.tsx`

**Step 7:** RED — a scan whose signal has `state: "unmeasured"` renders `Not measured`, and one with `state: "absent"` renders `Absent`; both carry `data-present="no"`.

**Step 8:** GREEN — derive the label from `state ?? (present ? present : absent)`.

**Step 9:** commit `test(433): RED — an unmeasured signal is not an absent one` then `feat(433): GREEN — the result column distinguishes three states`.

### Task 4 — CSS: declare the table class

**Objective:** the style contract stays green and the table looks like the rest of the board.

**Files:**
- Modify: `app/globals.css`

**Step 10:** add `.df-amm-table` to the existing grouped table selectors (`.df-cost-table, .df-policy-table, .df-amm-table`) so it inherits width, collapse, cell padding, borders and the first-column-left rule; add a small rule set for the group caption row and a muted `Not measured` result. Replace the now-unused `.df-amm-pillars` / `.df-amm-pillar` / `.df-amm-signals` rules (keep `.df-amm-capabilities` and `.df-amm-evidence` if still used).

**Step 11:** run `npx vitest run tests/dark-factory-ui/style-contract.test.ts` — expected PASS.

**Step 12:** commit `feat(433): GREEN — style the readiness table with the house table idiom`.

### Task 5 — docs and lint

**Step 13:** check `docs/pages/dark-factory-modules.md` (and any page describing the repo detail view) for a description of the readiness rendering; update it to say "table". Run the doc-drift guard.

**Step 14:** run the local lint gate on the changed files before pushing: pinned `cspell@9.1.1 -c .cspell.json`, `npx tsc --noEmit --incremental false`, and `markdown-table-formatter@1.6.1` + `markdownlint-cli@0.45.0` on any changed markdown (including this plan). Reword rather than teach the dictionary.

**Step 15:** commit docs.

## Files likely to change

| File                                       | Change                                                  |
|--------------------------------------------|---------------------------------------------------------|
| `app/dark-factory/ui/amm-scale.tsx`        | list → table; three-state result                        |
| `app/globals.css`                          | declare `.df-amm-table`; retire the old list classes    |
| `tests/dark-factory-ui/amm-scale.test.tsx` | new table + three-state assertions                      |
| `docs/pages/dark-factory-modules.md`       | describe the table (if it currently describes the list) |

## Validation

- Focused: `npx vitest run tests/dark-factory-ui/amm-scale.test.tsx tests/dark-factory-ui/repo-detail-page.test.tsx tests/dark-factory-ui/style-contract.test.ts`
- Type-check: `npx tsc --noEmit --incremental false`
- Full suite for regressions: `npm run test`
- Local lint gate on the changed files (cspell, markdown linters on the plan + docs)
- Manual: the user pulls the branch in the dev checkout (`C:\Dev\Eve\agent-eve`) and eyeballs `/dark-factory/repos/ricardoblackskye/agent-eve`

## Risks / open questions

1. **Table shape — the one decision worth your call.** This plan proposes a **signal-level** table (one row per signal, pillar as a `rowspan` group cell, plus a benchmark/evidence caption row). The alternative is a **pillar-level** summary table (one row per pillar: Pillar · Level · Benchmark · `Signals met n/m` · Evidence) with the signals left as detail. The signal-level table keeps every check visible; the pillar-level one is more compact. Say which you want and I will implement that; if you have no preference I will build the signal-level version.
2. **`state` is optional.** The fixture may omit it, so the derivation must fall back to `present`; both paths need a test.
3. **Retiring old CSS classes.** Dropping `.df-amm-pillars` / `.df-amm-pillar` / `.df-amm-signals` is safe only if nothing else uses them — verify with a grep before deleting, and keep `.df-amm-capabilities`.
4. **No ADR required.** This is a pure presentation change: no vendor/seam swap, no irreversible data decision, no fail-closed posture shift, no deliberate deferral. Per the trigger test ("will a competent developer ask *why is it like this?*"), the code answers it — no ADR is added in this change.
5. **The real scanner is not wired.** The page still reads the fixture provider; making the scanned results live is a separate issue. This change is markup only.
