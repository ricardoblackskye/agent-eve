# #254 — Wire the run detail page into the ledger

- Issue: [#254](https://github.com/ricardoblackskye/agent-eve/issues/254)
- Branch: `feat/run-detail-navigation-254`
- Date: 2026-10-04

## Goal

Clicking a run row in `/dark-factory/runs` navigates to the run detail page
`/dark-factory/runs/{runId}`. Drop the now-redundant inline "SELECTED RUN /
PREVIEW" tile, and migrate the detail page's panel heads to the shared
`PanelHead` chips.

## Current state (verified)

- `app/dark-factory/runs/[runId]/page.tsx` **exists and is a built route**
  (`/dark-factory/runs/[runId]/page` is in the app-path manifest): run control,
  `RunDetailPanel`, event stream, worker checkpoints, measured metrics.
- **Nothing links to it.** A repo-wide search for `dark-factory/runs/` in
  `app/**/*.tsx` finds no link. `app/dark-factory/runs/page.tsx:117` wires
  `RunTable onSelect={setSelectedRunId}`, which only fills the
  `<SelectedRunPreview>` aside (`:119-127`). So the detail page is reachable only
  by typing the URL.
- `SelectedRunPreview` (`app/dark-factory/ui/components.tsx:264`) is used by the
  runs page **only**; no test references it.
- The detail page (`[runId]/page.tsx`) uses raw
  `<div className="df-panel-head"><strong>…</strong><span>…</span></div>` markup
  for its 5 panel heads, so its badges are plain text, not the `PanelHead` chips
  used on the Overview.
- `.df-table-pane` (`app/globals.css`) is the 2-column ledger grid
  (`2fr 1fr`) that exists solely to host the table + preview aside.

## Decisions (confirmed with the user)

1. **Row click navigates** to the detail page; **drop** the inline preview tile.
2. **Migrate** the detail page's panel heads to `PanelHead`.

## Intended fix

- `RunTable`: add an optional `hrefForRun?: (runId: string) => string`. When
  supplied, the run-id cell renders as a `next/link` (keyboard-focusable) to the
  detail route, so the row is reachable by keyboard as well as by click. The row
  keeps its `onSelect` click handler, but the page now passes a **navigation**
  callback.
- `app/dark-factory/runs/page.tsx`: use `useRouter().push(`/dark-factory/runs/${id}`)`
  for `onSelect`; pass `hrefForRun`; **remove** the aside + `SelectedRunPreview`
  usage; render the table directly (no `.df-table-pane` wrapper).
- `components.tsx`: **remove** the now-dead `SelectedRunPreview`.
- `app/dark-factory/runs/[runId]/page.tsx`: replace the 5 raw panel heads with
  `<PanelHead title=… badges={[…]} />`.
- `app/globals.css`: remove the now-unused `.df-table-pane` rules; regenerate
  `tests/fixtures/df-css-baseline.json` (the CSS drift guard compares the
  resolved bag, so a legitimate removal must be regenerated — verified against
  the diff).

## Tasks (TDD — RED → GREEN)

1. **RED** — `RunTable` renders each run id as a link when `hrefForRun` is given:
   render `<RunTable rows={rows} hrefForRun={(id) => `/dark-factory/runs/${id}`} …/>`
   and assert `container.querySelector("a[href='/dark-factory/runs/df-…']")`.
   Run it; confirm it fails (no link today).
2. **GREEN** — implement `hrefForRun` + the `Link` in `components.tsx`.
3. **RED** — runs page navigates: `vi.mock("next/navigation")` with a `push` spy;
   mock `fetch` to return two runs; click a row; assert
   `push` was called with `/dark-factory/runs/<id>`; and assert the
   "SELECTED RUN" preview is **gone**.
4. **GREEN** — page uses `useRouter`, removes the aside/preview.
5. **RED** — detail page heads are chips: render the detail page (mocked fetch +
   `next/navigation` `useParams`) and assert `.df-chip` elements exist for the
   panel badges.
6. **GREEN** — migrate the detail page heads to `PanelHead`.
7. Remove `SelectedRunPreview` + the `.df-table-pane` CSS; regenerate the
   baseline; re-run the drift guard.
8. Local lint gate (cspell/tsc/prettier) then commit.

## Files likely to change

- `app/dark-factory/runs/page.tsx`
- `app/dark-factory/ui/components.tsx`
- `app/dark-factory/runs/[runId]/page.tsx`
- `app/globals.css`
- `tests/fixtures/df-css-baseline.json`
- `tests/dark-factory-ui/components.test.tsx` (RunTable link test)
- `tests/dark-factory-ui/runs-page.test.tsx` (new — navigation)
- `tests/dark-factory-ui/run-detail-page.test.tsx` (new — chips)

## Validation

- `npx vitest run` — full suite green, no regressions.
- `npx tsc --noEmit --incremental false` — clean.
- `npm run build` — green; confirm the route list still includes
  `/dark-factory/runs/[runId]`.
- Local lint clean (cspell/tsc/prettier) incl. this plan.
- Manual: `npm run dev`, open `/dark-factory/runs`, click a row → lands on the
  detail page; keyboard Tab to the run id and Enter also navigates.

## Risks / open questions

- `next/navigation`'s `useRouter` must be mocked in tests (`vi.mock`), since the
  page is a client component outside a Next runtime.
- Removing `SelectedRunPreview` is a dead-code removal — verified it has no other
  referents (repo-wide grep) and no tests.
- The CSS baseline must be regenerated for the `.df-table-pane` removal; verify
  the baseline diff contains only that removal.
- **No ADR**: a navigation wiring fix plus dead-code removal — no seam, vendor,
  or write-once decision.