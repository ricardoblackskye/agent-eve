# #205 — Dark Factory dashboards: bug fixes

- Issue: [#205](https://github.com/ricardoblackskye/agent-eve/issues/205)
- Branch: `fix/dashboard-bug-fixes-205`
- Date: 2026-10-04
- Delivery: **one PR** (UI/copy/CSS fixes + graceful error handling). No release split.

## Goal

Fix the Overview/Runs dashboard defects reported in #205: the nav labels, the panel
badge spacing, the two unstyled panels (LLM Cost Budgets, LLM Call Policy), the
Outcome Mix layout, and the error UX (a transient 503 must not blank the whole
board, and a "not configured" store must say so instead of showing a raw
`Request failed with status 503`). Confirm the newly-seeded data (#250) populates
the usage tiles.

## Root causes (verified in the code)

1. **Nav labels** — `app/dark-factory/layout.tsx:11-16` renders literal `O` and
   `R`; the words exist only as `title=` tooltips. The rail is sized for one
   glyph: `.df-app` grid column is `58px` and `.df-rail-link` is `38x38`
   (`app/globals.css`).
2. **Panel badge spacing** — the panel heads in `app/dark-factory/page.tsx:89-136`
   render `<strong>TITLE</strong><span>OPERATOR ONLY · READ ONLY</span>`.
   `.df-panel-head` exists (nested as `&-head`), but the badge needs explicit
   separation and to read as its own chip. **Exact visual cause to confirm
   against the running page before fixing.**
3. **Cost + Policy panels unstyled** — `app/globals.css` has **no rules** for
   `.df-cost-*` or `.df-policy-*` (grep-verified). That is the true reason the LLM
   Cost Budgets table and the LLM Call Policy table/summary look untidy.
4. **Outcome Mix** — `app/dark-factory/ui/components.tsx` `OutcomeMix` renders a
   flex-wrap row of `<span class="df-mix-item">` blocks. #205 asks for a table
   with consistent padding.
5. **A transient 503 blanks the whole page** — `app/dark-factory/page.tsx:51-54`
   short-circuits the entire overview to `<StatePanel state="error">` whenever
   `metrics.error ?? runs.error` is set. A single failed poll (metrics/runs) hides
   every tile until a manual reload; `useRunQuery` only re-polls every 60s.
6. **Raw, wrong 503 message** — `app/api/dark-factory/responses.ts`
   `serviceUnavailable()` hardcodes `{ error: "Run history is unavailable" }` for
   **every** store (wrong for cost/usage/control), and the client hooks surface
   only `Request failed with status ${status}`, discarding the server's message.
7. **Live Control / Cost Budgets 503 = config** — `createControlStore()` /
   `createCostBudgetStore()` fall back to a fail-closed stub when the app's env
   lacks `DF_CONTROL_DRIVER` / `DF_COST_BUDGET_DRIVER`; every read then returns
   `ok: false` → 503. This is the app-env mirror of the seed-env fix and is
   **out-of-code-scope** (the user sets env), but (6) makes the tile explain it.
8. **"No usage recorded" / Customer Usage** — written before #250. The usage
   query has **no default window** (all time), so the #250 seed should populate it
   once the app points at the seeded DB. → verify; if still empty, it is the app
   env (same config fix).

## Intended fix

- (1) Render **"Overview"** and **"Runs"** as the link text; widen the rail /
  rail-link so the words fit without breaking the layout.
- (2) Render the role/access badges as **distinct, spaced chips**, consistent
  across every panel head.
- (3) Add `.df-cost-*` and `.df-policy-*` CSS reusing the existing
  `.df-panel`/`.df-table` visual language; tidy the policy table columns.
- (4) Convert `OutcomeMix` to a `<table class="df-table">` (Outcome · Count ·
  Share) with consistent padding.
- (5) `page.tsx`: never blank a populated board on a transient error — keep the
  last-good data and show a non-blocking banner; only render the full-page error
  state when there is **no data yet**.
- (6) `serviceUnavailable(message?)` takes a store-specific message; each route
  passes its own ("Cost budgets are unavailable", "Usage ledger is unavailable",
  "Control state is unavailable", "Run history is unavailable"). The client hooks
  surface the server `{ error }` body when present, else fall back to the status
  text.
- (7) Out-of-code: document the exact `.env.local` lines (all five
  `DF_*_DRIVER=postgres` + the three connection URLs) so the tiles populate. The
  user applies them.
- (8) Verify the usage/customer tiles populate; if empty, treat as config.

## Tasks (TDD — RED → GREEN)

RED (tests first, failing for the right reason):
- `layout` renders the words "Overview" and "Runs" (not bare `O`/`R`).
- `OutcomeMix` renders a `<table>` with a padded row per segment.
- `useRunQuery` surfaces the server `{ error }` message on a 503 body and clears
  it on the next success; `useFactoryControl` likewise.
- Overview page: a transient metrics error **with existing data** keeps the tiles
  and shows a banner (no full-page blank).
- `responses.serviceUnavailable("x")` returns `{ error: "x" }`.
- CSS guard: `.df-cost-*` and `.df-policy-*` selectors exist (assert via
  `fs.readFileSync("app/globals.css")` — the repo's CSS-test pattern).

GREEN: implement the above; keep the full suite green.

Local lint gate before any push: `cspell@9` on changed files (incl. this plan),
`standard`/eslint, `prettier`, `tsc --noEmit --incremental false`.

## Files likely to change

- `app/dark-factory/layout.tsx`
- `app/dark-factory/page.tsx`
- `app/dark-factory/ui/components.tsx` (OutcomeMix)
- `app/dark-factory/ui/use-run-query.ts`, `app/dark-factory/ui/use-factory-control.ts`
- `app/api/dark-factory/responses.ts` + the affected routes (control, cost-budgets,
  usage, tenants, metrics, runs)
- `app/globals.css` (rail width, badge chips, `.df-cost-*`, `.df-policy-*`)
- tests under `tests/dark-factory/` (and `tests/integration/` for the page)
- `README.md` / `.env.example` note for the five `DF_*_DRIVER` vars (config docs)

## Validation

- `npx vitest run` — full suite green, no new regressions.
- `npx tsc --noEmit --incremental false` — clean.
- `npm run build` — green.
- Local lint clean (cspell/standard/prettier) incl. dotfiles + plan.
- Manual: `npm run dev` against the seeded Supabase test project — confirm nav
  labels, spaced badges, styled cost + policy tables, Outcome Mix table, no
  page-blank on a forced 503, and populated usage/customer tiles.

## Risks / open questions

- (2) the exact visual cause of the "operator/read only" spacing — confirm against
  the running page before/after the change.
- (7) the 503s are config-dependent; the PR makes the message honest but does
  **not** set your environment. Exact `.env.local` lines will be supplied.
- Scope confirmed by the user: **one PR**; graceful error handling included.
- **No ADR**: no new seam/vendor/write-once decision — purely presentational plus
  an error-message contract the existing routes already imply.