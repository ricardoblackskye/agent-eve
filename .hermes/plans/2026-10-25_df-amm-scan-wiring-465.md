# AMM readiness reads the measure, not the fixture — Implementation Plan

> **For Hermes:** follow this plan task by task. RED before GREEN, one behaviour per cycle, and stop at
> GATE 1 until the plan is approved.

**Goal:** make a scan produced by `npm run df:amm-scan` reach the repository list and the repository detail
page, so every readiness figure on screen is measured rather than asserted.

**Architecture:** the scan seam (`AmmReadinessProvider`) already has two adapters — the fixture and the
database. Nothing writes the database adapter's table and nothing reads it from a page. This change closes
both links and retires the fabricated default.

**Tech stack:** TypeScript, Next.js App Router (server pages + one API route), Vitest, `node:sqlite` /
Postgres through the existing `AmmScanStore`.

---

## Root cause (verified on `main`, not inferred)

| Link                                                | State today                                                              |
|-----------------------------------------------------|--------------------------------------------------------------------------|
| `scripts/amm-scan.ts:83` (`npm run df:amm-scan`)    | Writes the scan JSON to **stdout**; never calls the store                |
| `AmmScanStore.recordScan` (`amm-scan-store.ts:46`)  | **No production caller** — only the two drivers and tests                |
| `databaseAmmProvider` (`amm-scan-provider.ts:52`)   | **Tests only** — no page, no route                                       |
| `defaultAmmProvider()` (`amm-readiness.ts:294`)     | `fixtureAmmProvider([agentEveScan()])` — always the fixture              |
| `app/dark-factory/repos/page.tsx:24`                | Calls `defaultAmmProvider()` (server component)                          |
| `app/dark-factory/repos/[owner]/[name]/page.tsx:53` | Calls `defaultAmmProvider()` inside a `useEffect` (**client** component) |

So the write side has no caller and the read side points at the fixture. `df:amm-scan` measures a repository
and then discards the measurement.

`defaultAmmProvider()` returns a transcribed scan of `ricardoblackskye/agent-eve` (74/100, Level 4). That is a
fabricated measurement rendered as a measurement, which the module catalogue already records a decision
against, for #424:

> FAIL-CLOSED: an unconfigured driver throws rather than falling back to the fixture or to an empty table,
> because an empty table renders as "no repositories are ready" — which looks like a measurement and is not one.

The pages contradict that recorded decision. This plan is mostly about making them agree with it.

## The decision this plan asks you to confirm

**What should happen when no scan store is configured?** My recommendation, which matches the recorded #424
decision, is **fail loudly**:

- Driver set → read the store.
- Driver unset → throw with a message naming `DF_AMM_SCAN_DRIVER`. The page errors rather than showing a
  fabricated level.
- The fixture becomes test-only: `fixtureAmmProvider` / `agentEveScan` stay exported, but no page may use them.

The consequence to accept up front is that both pages then require the store to be configured in every
runtime that renders them, including Vercel preview. The alternative — a third, **explicit** driver value
`DF_AMM_SCAN_DRIVER=fixture` for local demos with no database — was **considered and rejected**: fail loudly,
and no fixture driver value is added. `fixtureAmmProvider` / `agentEveScan` stay exported for tests only, and
no page or route may import them.

## Intended fix

1. **A server-side selector.** Make the choice in `amm-scan-provider.ts` (which already imports the drivers),
   not in `amm-readiness.ts` — that module is imported by the client component `amm-scale.tsx`, so it must
   stay free of `node:sqlite` and Postgres imports.
2. **Record what was measured.** `df:amm-scan` records the scan through the configured store and reports the
   store and row it wrote; with no store configured it prints the scan and says plainly that it was NOT
   persisted.
3. **The list page reads the store.** It is a server component, so it takes the provider directly.
4. **The detail page reads the store across a server boundary.** It is a client component, so it cannot hold
   a database provider; it fetches a new route instead — the shape the same page already uses for runs.
5. **Retire the fabricated default.** `defaultAmmProvider` stops appearing in `app/`.

## Tasks

### Task 1 — the selector (RED → GREEN)

**Files:** modify `agent/lib/dark-factory/amm-scan-provider.ts`; test `tests/dark-factory/amm-scan-provider.test.ts`.

**Behaviour:** `ammProviderFromEnv(env)` returns a provider backed by the configured store.

**Step 1 (RED):** in `tests/dark-factory/amm-scan-provider.test.ts`, add two cases:

```ts
it("reads the scan the store holds for a repo", async () => {
  const store = new SqliteAmmScanStore(dbPath);
  await store.recordScan(toStoredScan(scan, "tenant-1"));
  const provider = ammProviderFromEnv({ DF_AMM_SCAN_DRIVER: "sqlite", DF_AMM_SCAN_DB_PATH: dbPath });
  expect((await provider.scan("owner/repo"))?.overall.level).toBe(scan.overall.level);
});

it("refuses to invent a provider when no driver is configured", () => {
  expect(() => ammProviderFromEnv({})).toThrow(/DF_AMM_SCAN_DRIVER/);
});
```

**Step 2:** run `npx vitest run tests/dark-factory/amm-scan-provider.test.ts`. Expected: the first case fails
on a missing export, the second fails for the same reason. (Declare the signature first if a missing export
aborts collection — see the pitfalls in `ai-sdlc-workflow`.)

**Step 3 (GREEN):**

```ts
export function ammProviderFromEnv(env: AmmScanStoreEnv = process.env as AmmScanStoreEnv): AmmReadinessProvider {
  return databaseAmmProvider(createAmmScanStore(env));
}
```

**Step 4:** rerun; both pass. **Step 5:** commit RED, then GREEN.

### Task 2 — `df:amm-scan` records what it measured (RED → GREEN)

**Files:** modify `agent/lib/dark-factory/amm-scan-provider.ts` (the testable helper) and
`scripts/amm-scan.ts` (a thin caller); test `tests/dark-factory/amm-scan-provider.test.ts`.

**Behaviour:** given a scan, record it when a store is configured and report what happened.

**Step 1 (RED):** add a case asserting the outcome shape — recorded (with the store id and row id) versus
not-persisted (with a reason), and that a **repeat** scan appends a second row rather than replacing the
first (the store is append-only by design).

**Step 2:** run it; expect failure.

**Step 3 (GREEN):** add

```ts
export interface RecordScanOutcome {
  recorded: boolean;
  storeId?: string;
  rowId?: string;
  reason?: string;
}

export async function recordAmmScan(
  scan: AmmScanResult,
  env: AmmScanStoreEnv = process.env as AmmScanStoreEnv,
  tenantId?: string,
): Promise<RecordScanOutcome>;
```

and in `scripts/amm-scan.ts` call it after `runAmmScan`, printing the outcome to stderr next to the existing
summary. Add a `--tenant` flag alongside the existing `--repo/--workspace/--layout`.

**Step 4:** rerun. **Step 5:** commit RED, then GREEN.

### Task 3 — the list page reads measured scans (RED → GREEN)

**Files:** modify `app/dark-factory/repos/page.tsx`; test `tests/dark-factory-ui/repos-page.test.tsx`.

**Step 1 (RED):** extend `repos-page.test.tsx` so it fails while the page still reads the fixture — assert the
row a store holds is rendered, and that the fixture's repo is **not** rendered when the store has no scan for
it.

**Step 2:** run it; expect failure. **Step 3 (GREEN):** `provider: ammProviderFromEnv()` and drop the
`defaultAmmProvider` import. **Step 4:** rerun. **Step 5:** commit RED, then GREEN.

### Task 4 — the detail page reads across a server boundary (RED → GREEN)

**Files:** create `app/api/dark-factory/amm-scans/route.ts`; modify
`app/dark-factory/repos/[owner]/[name]/page.tsx`; test `tests/dark-factory/amm-scans-route.test.ts` and
`tests/dark-factory-ui/repo-detail-page.test.tsx`.

**Step 1 (RED):** a route test in the shape of the runs route: guarded by `resolveViewer`, `200` with the
latest scan, `200` with a null scan for a repo nobody has scanned, and a store failure surfacing as an
unavailable response rather than an empty list.

**Step 2:** run it; expect failure (the route does not exist).

**Step 3 (GREEN):** add the route, reusing `resolveViewer`, `unauthorized`, `forbidden`, `badRequest`,
`serviceUnavailable` and `okJson` from `app/api/dark-factory/responses.ts`, and the provider from Task 1.
Then change the detail page's `useEffect` to fetch `/api/dark-factory/amm-scans?repo=...` instead of importing
the provider, keeping the existing null-scan handling.

**Step 4:** rerun, plus `npx tsc --noEmit --incremental false` — a client component importing a server-only
module is a build failure, and the type-check is where it shows first.

**Step 5:** commit RED, then GREEN.

### Task 5 — retire the fabricated default

**Files:** modify `agent/lib/dark-factory/amm-readiness.ts`, `docs/pages/dark-factory-modules.md`.

- Delete `defaultAmmProvider` (or leave it deprecated **only** if a caller remains — grep `app/` first; the
  acceptance criterion is that it appears in no page or route).
- Keep `fixtureAmmProvider` and `agentEveScan` — tests use them, and `amm-scale.test.tsx` renders them.
- Update the catalogue rows: `## AMM readiness` ("Supplies the fixture scan that the web repository list
  renders" is no longer true) and `## AMM scan provider` (document the page-facing selector).

### Task 6 — ADR and gates

- Write **ADR 0060 — AMM readiness is read from the measure, and the UI has no fabricated default**: the
  context (a fixture that reads as a measurement), the decision (fail closed, fixture test-only), and the
  consequence (the store must be configured in every runtime that renders the pages). Add the index row in
  `docs/adr/README.md`.
- Gates: `npx vitest run` (full), `npx tsc --noEmit --incremental false`, `npx cspell@9.1.1 -c .cspell.json`
  on the changed files, the docs guards, and `next build`.

## Files likely to change

| File                                                                             | Change                                          |
|----------------------------------------------------------------------------------|-------------------------------------------------|
| `agent/lib/dark-factory/amm-scan-provider.ts`                                    | `ammProviderFromEnv`, `recordAmmScan`           |
| `agent/lib/dark-factory/amm-readiness.ts`                                        | retire `defaultAmmProvider`                     |
| `scripts/amm-scan.ts`                                                            | record the scan, `--tenant`, report the outcome |
| `app/dark-factory/repos/page.tsx`                                                | read through the selector                       |
| `app/dark-factory/repos/[owner]/[name]/page.tsx`                                 | fetch the new route                             |
| `app/api/dark-factory/amm-scans/route.ts`                                        | new, guarded read route                         |
| `tests/dark-factory/amm-scan-provider.test.ts`                                   | selector + record                               |
| `tests/dark-factory-ui/repos-page.test.tsx`                                      | list reads the store                            |
| `tests/dark-factory-ui/repo-detail-page.test.tsx`                                | detail fetches the route                        |
| `tests/dark-factory/amm-scans-route.test.ts`                                     | new route test                                  |
| `docs/adr/0060-*.md`, `docs/adr/README.md`, `docs/pages/dark-factory-modules.md` | the record + catalogue                          |

## Validation (provable on this machine)

```bash
export DF_AMM_SCAN_DRIVER=sqlite
export DF_AMM_SCAN_DB_PATH="$LOCALAPPDATA/Temp/df378/amm.sqlite"
npm run df:amm-scan -- --repo ricardoblackskye/agent-eve --workspace .
npm run dev            # then open /dark-factory/repos and the repo detail page
```

Expected: the scan command reports the store and row it wrote, and both pages show the measured level instead
of 74/100 from the fixture. Command-backed signals still report `unmeasured` (no sandbox on this host) — that
is correct and is what #437 established.

## Risks and open questions

- **Behaviour change:** an unconfigured store turns a working page into an error page. That is the point of
  fail-closed, but it makes `DF_AMM_SCAN_DRIVER` mandatory in preview and production — an operator step, not
  a code step (see below).
- **The detail page's read moves from a direct call to a request.** The page already fetches runs, so the
  shape is familiar, but it does add a round trip.
- **Scope:** confirmed as **one change** — four code changes plus docs in a single PR. The split below was
  offered and declined:
  ~~R1 (persist + selector + list page) / R2 (detail page + route)~~.
- **Unblocks #436**, which needs measured scan data to render capability detail; it does not implement it.
- The store's `latestScans` is read without a tenant filter today, so the page shows the newest scan for the
  repo whoever wrote it. Left as-is here; worth its own decision if per-tenant readiness is ever wanted.

## Operator steps (yours, not code)

Set the store for each Vercel environment that renders these pages, for example
`DF_AMM_SCAN_DRIVER=postgres` with `DF_AMM_SCAN_DATABASE_URL` pointing at the same database the other Dark
Factory adapters use. Until that is set, the two pages will refuse rather than show a figure.
