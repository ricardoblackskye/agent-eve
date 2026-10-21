# #424 — persist AMM scans: version-stamped, tenant-attributed history

## Ground truth (read in the code, not assumed)

- The seam exists: `AmmReadinessProvider.scan(repo)` in `amm-readiness.ts`, today satisfied by the fixture. A database
  adapter implements the SAME interface, which is why the pages do not change.
- The model exists: `scoreRepo()` (pure, clock as an input) returns an `AmmScan` carrying per-signal `level`, `points`
  and `state`.
- The house style for a store: an interface plus two drivers. `run-history-store.ts` defines the seam and a SQLite
  driver with an inline `SQLITE_SCHEMA`; `run-history-postgres.ts` does `CREATE TABLE IF NOT EXISTS` inside an
  `ensureSchema()`; `run-history-provider.ts` chooses between them by env and is FAIL-CLOSED when unconfigured.
- Migrations are `db/migrations/NNN_df_*.sql`, next is `009`. RLS is not enabled in the table DDL: migration `006`
  enables row-level security on every `df_` table and there is a guard test that fails when a table is missed.

## THE CONSTRAINT FROM #426 — read this before the schema

#426 (the scanner/runner) is what produces measurements, and it is not built yet. The one thing it will change is
**`state`**, because the runner is what decides that a check which *could not run* is `unmeasured` rather than absent.
So this release must not bake in a two-state shape it would then have to migrate:

- `state` is stored as a **triad** (`present` / `absent` / `unmeasured`) from the first migration, as a constrained
  value, never as a boolean and never as a nullable flag.
- Nothing in the read path may treat `unmeasured` as `absent`. The stored value is carried through verbatim.
- The row shape is otherwise derived from what `AmmScan` already contains, so the runner needs no schema change to
  land - it changes what is MEASURED, not what is STORED.

## Design

**`agent/lib/dark-factory/amm-scan-store.ts`** - the seam, plus a SQLite driver, mirroring the run-history pattern:

```ts
export interface StoredAmmSignal {
  id: string;
  level: number;
  points: number;
  state: "present" | "absent" | "unmeasured";
}

export interface StoredAmmScan {
  repo: string;
  /** Absent means UNASSIGNED, a legitimate state for scans taken before attribution existed (mirrors run history). */
  tenantId?: string;
  scannedAt: string;
  /** Which catalogue produced this score (#426 AC6): scores from different versions are not comparable. */
  catalogueVersion: string;
  points: number;
  level: number;
  label: string;
  pillars: StoredAmmPillar[];
}

export interface AmmScanStore {
  id: string;
  recordScan(scan: StoredAmmScan): Promise<WriteResult<StoredAmmScan>>;
  /** The newest scan per repository, optionally scoped to one tenant. */
  latestScans(options?: { tenantId?: string; repo?: string; limit?: number }): Promise<ReadResult<StoredAmmScan[]>>;
  /** The full append-only series for one repository, newest first. */
  history(repo: string, options?: { tenantId?: string; limit?: number }): Promise<ReadResult<StoredAmmScan[]>>;
  close(): void | Promise<void>;
}
```

- **Append-only** (AC3): `recordScan` always INSERTs. The series per (repo, tenant) is the point; `latestScans` picks
  the newest row per repository, which is what the UI reads.
- **Per-signal detail is stored as JSON, not rows.** 39 signals x every scan as rows would be a table that grows
  sideways for no query benefit; the queryable fields (repo, tenant, scanned_at, catalogue_version, points, level) are
  real columns so the leaderboard-style queries stay indexed. The tradeoff is named here so it is a decision, not an
  accident.
- **Catalogue version** (AC2) comes from a `catalogueVersion()` digest over the catalogue's (id, level) pairs, added
  beside the catalogue. A `comparable(rows)` helper REFUSES a mixed-version set, so comparing across a weight change
  is a deliberate act rather than a silent one.

**`agent/lib/dark-factory/amm-scan-postgres.ts`** - the deployed driver, same interface, `ensureSchema()`.

**`agent/lib/dark-factory/amm-scan-provider.ts`** - `createAmmScanStore(env)` (fail-closed, `DF_AMM_SCAN_DRIVER`
unset => refuse rather than silently no-op) plus `databaseAmmProvider(store)`, the adapter that finally satisfies
`AmmReadinessProvider` from storage instead of the fixture.

**`db/migrations/009_df_amm_scans.sql`** - the table, the `CHECK (state IN (...))` constraint on the signal triad, and
`ENABLE ROW LEVEL SECURITY`, which the existing coverage guard will insist on.

## Tasks

**1 (RED) - tenant attribution (AC1).** Two tenants' scans for the SAME repo must not mix: `latestScans({tenantId})`
returns only that tenant's rows, and readiness computed from them is that tenant's alone.

**2 (RED) - the triad survives storage (AC4).** A scan carrying present, absent AND unmeasured round-trips exactly.
Written to fail against a boolean `present` column: the assertion is that all three states come back distinguishable.

**3 (RED) - append-only history, latest wins (AC3).** Two scans for one repo both persist; `latestScans` returns the
newer; `history` returns both, newest first.

**4 (RED) - the catalogue version stamps and guards (AC2).** A recorded scan carries the current version; a set
spanning two versions is REFUSED by `comparable()` rather than averaged.

**5 (RED) - a repo with no scan is unmeasured, not zero (AC5).** The provider returns `undefined`; nothing fabricates
a Level 1.

**6 (GREEN)** - implement the seam, both drivers, the provider and the migration.

**7** - the doc-drift guard requires every DF module documented; add all three to `docs/pages/dark-factory-modules.md`.

## Validation

- `npx tsc --noEmit --incremental false`
- the new tests, then the FULL suite (no `DF_*` variables exported in the shell - they leak and break the tests that
  assert an unconfigured store)
- `npx cspell@9.1.1 -c .cspell.json` over the whole diff, staged first; remember CI's cspell flags words the local one
  does not, so grep the diff for the known offenders too
- `npm run coverage:ratchet` via CI's coverage gate
- the SQLite contract tests must pass with NO environment variables set, which is the state CI's unit job uses

## Risks

- **A nullable `state` would collapse `unmeasured` into `absent` on the way to disk** - the exact regression #426 would
  then have to unpick. Constrained column, tested round-trip.
- **Mixing tenants makes readiness wrong for everyone, silently** - hence a tenant-scoped read and a test with two.
- **Comparing scores across catalogue versions** would look like a trend and be an artifact; `comparable()` refuses.
- **A silent no-op when unconfigured** would render an empty list as "no repos are ready" - the factory refuses instead,
  as the run-history provider does.
