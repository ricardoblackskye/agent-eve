# Dark Factory overview page — styling refinement (issue #258)

- Issue: [#258](https://github.com/ricardoblackskye/agent-eve/issues/258) — Dark Factory Overview page updates
- Branch: `feat/df-overview-styling-258` (off `main` `1695049`)
- Delivery: one PR (four small UI defects, one surface)
- Status: **plan only — no code written yet**

## Goal

Make the Dark Factory overview page render cleanly: the usage tables styled and padded like the
other panels, the recent-executions list a real table with even columns and headers, and the outcome
trend a genuine line chart rather than a solid block.

## Defects, and the root cause of each

| # | Reported                                                                                      | Root cause                                                                                                                                                                      | Evidence                                                                                              |
|---|-----------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| 1 | LLM Usage "Totals" and "By run" tables need styling and padding, consistent with other tables | **`.df-usage-table` has no CSS rule at all** — the class is used by four components and styled by nothing                                                                       | `grep -n "df-usage" app/globals.css` → 0 matches; the class is used in `usage-panel.tsx:54,76,96,116` |
| 2 | Customer Usage table needs the same styling                                                   | Same missing rule — `tenant-usage-panel.tsx` uses the identical `df-usage-table`                                                                                                | `tenant-usage-panel.tsx:107`                                                                          |
| 3 | Recent executions: columns not even, no column headers                                        | `RecentRunsList` is **not a table** — a flex column of `div`s on a `76px 1fr auto` grid with no `thead`                                                                         | `components.tsx:198-214`; `.df-recent-row` grid at `globals.css:433-440`                              |
| 4 | Outcome Trend "showing as just a blue block"                                                  | `TrendChart` renders `div.df-trend-bar` children with `flex: 1` and a percentage height, so with one or two dates the bars stretch to fill the full width — a single wide block | `components.tsx:147-169`; `.df-trend-bar { flex: 1; background: #77b7ff }` at `globals.css:403-407`   |

There is direct precedent for defect 1/2: `globals.css:755-756` carries the comment *"these shipped
with no styles at all, so the tables rendered untidily"* from the same class of fix in #205. The
pattern to copy is `.df-cost-table` / `.df-policy-table` (`globals.css:777-806`).

### Adjacent defect found while looking (not reported)

`.df-budget-table` (used by `tenant-budget-panel.tsx`) is **also unstyled** — it has no rule in
`globals.css` either, and it sits in the same "Customer Usage" panel the issue is about. It is in
scope for this change; it is the same fix and the same defect class.

## Decisions

1. **Follow the existing convention: plain CSS `df-*` classes in `app/globals.css`**, mirroring the
   #205 cost/policy table block. These rules sit outside Tailwind's layers so they win over layered
   utilities (`globals.css:12-13`), and the whole dark-factory surface is already written this way.
2. **Do not reformat `app/globals.css`.** It is prettier-dirty and its rules are hand-flattened (from
   the #241 SCSS-nesting fix). Add rules by hand in the existing style; a prettier pass would produce
   a whole-file diff and bury the change.
3. **One shared rule set for `.df-usage-table`**, so defects 1 and 2 are fixed once rather than
   duplicated per component.
4. **Convert the recent-executions list into a real `<table>`** rather than restyling the `div` grid —
   the issue asks for column headers, which a `div` grid cannot express accessibly.
5. **Render the trend as inline SVG** (a `polyline` plus point markers) with a `viewBox` so it scales
   to any number of dates, including one.
6. **Add a style-contract guard test** so this defect class cannot recur: every `df-*-table` class
   used in `app/dark-factory/**/*.tsx` must have a rule in `app/globals.css`. This would have caught
   both this issue and the #205 one.

## Legs

| Leg | Issue | Outcome                                                                                                                                                 | Proposed branch (if split)     |
|-----|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------|
| 0   | #258  | Style-contract guard: RED listing the unstyled table classes                                                                                            | `feat/df-overview-styling-258` |
| 1   | #258  | Style `.df-usage-table` and `.df-budget-table` (width, `border-collapse`, padding, right-aligned tabular numerals, uppercase header, first column left) | same                           |
| 2   | #258  | Recent executions becomes a real table: `<thead>` with column headers, even column widths, status pill and meta preserved                               | same                           |
| 3   | #258  | Outcome Trend becomes an SVG line chart with points, axes-free minimal styling, and a single-point case that still reads as a chart                     | same                           |
| 4   | #258  | E2E + responsive sanity on the overview page; update the plan's validation section                                                                      | same                           |

## Release shape

One PR. Four contained UI defects on a single page, no schema, no config, no contract change — the
split would cost more in review overhead than it saves. (For contrast, R3 of epic #212 was split
because it carried a migration, a new store and an auth seam.)

## Files likely to change

- `app/globals.css` — add `.df-usage-table`, `.df-budget-table`, table-header, and trend rules; retire
  `.df-trend-bar` if the SVG replaces it
- `app/dark-factory/ui/components.tsx` — `RecentRunsList` (table), `TrendChart` (SVG)
- `app/dark-factory/ui/usage-panel.tsx` — captions/wrapper if the layout needs a grid
- `app/dark-factory/ui/tenant-usage-panel.tsx` — align with the shared table styling
- `app/dark-factory/ui/tenant-budget-panel.tsx` — budget table class
- `app/dark-factory/ui/customer-view.tsx` — uses `df-usage-table`; must not regress
- Tests: `tests/dark-factory-ui/` — new `style-contract.test.ts`, plus updates to the component tests
  that assert on the recent list and the trend

## Tests and validation

- New guard: `tests/dark-factory-ui/style-contract.test.ts` — fails while any `df-*-table` class used
  by the dark-factory components lacks a `globals.css` rule.
- `TrendChart`: asserts an `svg` with a `polyline` whose point count equals the distinct dates, that a
  single point still renders a visible marker, and that the empty state is unchanged.
- `RecentRunsList`: asserts a `table` with a `th[scope="col"]` per column, the same row data as
  before, and the status pill still present.
- `npx vitest run tests/dark-factory-ui` — panel/component suites green.
- `npx tsc --noEmit --incremental false` — clean.
- `npm run build` (`DF_PLATFORM_PROVIDER=generic`) — the overview page still compiles.
- Playwright: the overview page renders the table headers and an `svg` trend.
- Local lint gate before every push: cspell@9.1.1 over changed files, markdown-table-formatter,
  prettier **only** on files that were prettier-clean on `main` (`globals.css` is NOT — hand-edit).

## Decisions (confirmed by the operator)

1. **Match the existing convention** — plain CSS `df-*` classes in `app/globals.css`, mirroring the
   #205 cost/policy table block. ADR 0009's Tailwind preference is not applied to this page.
2. **Align consistently with the content**, not equal widths: text left, numerals right-aligned with
   tabular numerals, natural column widths. Column headers are still required.
3. **The unstyled budget table is in scope** — style `.df-budget-table` as well.
4. **Match existing colors** — reuse the neighboring rules' hex values; introduce no tokens and
   shift nothing else.

Remaining risk: `app/globals.css` is prettier-dirty, so new rules are hand-added; never reformat it.

## Out of scope

Dark-mode/light-mode work, the `PanelHead` chips, the run-detail page, mobile layout below the
existing breakpoints, and any change to what the panels display (this issue is styling only).