# #159 — operator CLI for the self-improvement gate

**Branch:** `feat/df-operator-cli-159` (off `origin/main` = `507ff7a`)
**Issue:** #159 · follows #160 (PR #165), precedes #157 in the follow-up sequence

## Why this is the unlock, not a convenience

**Nothing in the application ever arms a decision.** Searching for callers of the
operator-decision store finds only the metrics store's own `.record(` calls;
`createOperatorDecisionStore` is re-exported from `index.ts:140` but **never called
outside its test** (`tests/dark-factory/self-improve-operator.test.ts`).

The consequence is structural, not cosmetic. In `self-improve.ts`:

```
747  if (proposal.kind === "access-widening") {
748    if (!config.operatorGate) return { status: "blocked", reason: "operator gate missing" };
751    if (!(await config.operatorGate.approve(proposal)))
752      return { status: "blocked", reason: "operator gate declined" };
```

With no way to record an `allow`, every `access-widening` proposal is blocked
permanently, with the reason *"operator gate missing"*. The CLI is how the gate is
satisfied at all — which is why #157 (the real skill surface) is sequenced behind it.

## REVIEW findings (from the code)

- **The store API is already right**: `createOperatorDecisionStore(store)` →
  `record` / `get(surfaceId, kind, now?)` / `list` / `clear(surfaceId, kind)`.
- **`OperatorDecision`**: `{ surfaceId, kind: "bounded-tuning" | "access-widening",
  decision: "allow" | "deny", decidedBy, decidedAt, expiresAt: string | null }`.
  `decidedBy` is documented as **"recorded for audit, not authenticated"**.
- **Unparseable expiry is treated as EXPIRED**, never as still valid — an existing
  fail-closed stance the CLI must not undermine by writing a garbage timestamp.
- **There is no TypeScript script runner.** `scripts/` holds only `pr-reviewer.js`
  (plain JS) and a `.mjs` policy test; `devDependencies` have no `tsx`/`esbuild`;
  `package.json` scripts are `dev`, `build`, `start`, `test`, `test:e2e`,
  `eve:build`, `typecheck`.
- **The store the CLI arms must be the store the app reads.** `createStateStore(env)`
  chooses by `DF_STATE_DRIVER` / `DF_STATE_DB_PATH`, and an unset driver yields the
  **fail-closed `ConsoleStateProvider` that refuses every write** — arming against it
  would silently be a no-op (see the refusal requirement below).

## Design

### Split: a pure command layer, plus a thin shim

- `agent/lib/dark-factory/operator-cli.ts` — **pure and fully tested**: parses argv
  into a command, executes it against an injected store, clock and writer, and
  returns `{ lines, exitCode }`. No `process`, no `console`, no filesystem.
- `scripts/self-improve-operator.ts` — ~20 lines: real store from
  `createStateStore(process.env)`, `console.log`, `process.exitCode`, `store.close?.()`.

Keeping the logic out of `scripts/` is what makes it testable without spawning a
process, and keeps the CLI behaviour identical wherever it is invoked from.

### Commands

| Command | Effect |
| --- | --- |
| `list` | Every recorded decision; expired ones listed and marked expired |
| `allow <surfaceId> [--kind K] [--by NAME] [--expires T]` | Records `decision: "allow"` |
| `deny <surfaceId> [--kind K] [--by NAME] [--expires T]` | Records `decision: "deny"` |
| `clear <surfaceId> [--kind K]` | Revokes the decision for that pair |

`--kind` defaults to `access-widening` (the only kind that needs a gate).
Exit codes: **0** success · **1** refusal or configuration error · **2** usage error,
so it is usable from a script or a CI check.

### Fail-closed rules the CLI must honour

1. **Arming against a store that cannot persist is REFUSED**, with an explanation —
   if the driver resolves to the fail-closed `console` provider, `allow` must not
   print a success that is a lie.
2. **A malformed `--expires` is REFUSED**, never written as `null`. Writing null on
   a typo would silently mean "valid until superseded", which converts a parse error
   into an unbounded grant. This mirrors the existing *unreadable expiry = expired*
   stance from the other direction.
3. **`--by` is required when arming an `allow` on `access-widening`.** The record is
   audit-only and not authenticated (per the type's own comment), so the CLI will not
   fabricate an author for the single most consequential decision it can make.
4. **The command echoes `store.id` and the resolved database path** it just wrote to,
   so the operator can see *which* store was armed — the documented hazard being an
   ephemeral local file when production reads a different one.

### `--expires` syntax

ISO-8601, or relative (`+7d`, `+12h`, `+30m`) evaluated against the injected clock.
`--expires never` (or omission) means `null` = until superseded — explicit, never the
accidental result of a typo.

## The one open decision: a TypeScript script runner

`scripts/` has no way to run `.ts`. Recommended: add **`tsx` as a devDependency**
(dev-only, nothing ships to the deployed app, but it changes the lockfile and CI's
install surface). Alternative: compile with the existing `typescript@7.0.2` before
running, which avoids the dependency but is clunkier to use and to script.

## Tasks (RED → GREEN, one behaviour per cycle)

| # | RED (failing test first) | GREEN |
| --- | --- | --- |
| 1 | `allow x --kind access-widening --by me` records exactly that decision, `decidedAt` from the injected clock | argv → command → `store.record` |
| 2 | `allow` without `--by` on access-widening ⇒ refused, exit 1, **nothing recorded** | audit-author requirement |
| 3 | `--expires soon` / `2030-13-45` ⇒ refused, exit 1, nothing recorded | strict expiry parse |
| 4 | `--expires +7d` ⇒ ISO computed from the injected clock | relative expiry |
| 5 | `--expires never` / omitted ⇒ `expiresAt: null` | explicit null only |
| 6 | `deny x` records `decision: "deny"` | shared record path |
| 7 | `clear x` removes the pair, exit 0 | `store.clear` |
| 8 | `list` shows live and expired entries, marking expired (injected clock) | read path |
| 9 | unknown command / missing `surfaceId` ⇒ exit 2 naming the problem | usage errors |
| 10 | a store that refuses writes (the `console` driver) ⇒ `allow` refused, exit 1, explains why | persistence pre-check |
| 11 | success output names `store.id` and the resolved path | which-store echo |

## Files

`agent/lib/dark-factory/operator-cli.ts` (new, pure) ·
`scripts/self-improve-operator.ts` (new, shim) ·
`tests/dark-factory/operator-cli.test.ts` (new) ·
`package.json` (devDep + an `operator` script) · `README.md` (how to arm a decision) ·
`.cspell.json` if needed.

## Validation

`npx tsc --noEmit` · full `npx vitest run` · cspell + prettier on changed files —
**and one real run on this laptop** against a local SQLite store, showing `allow`,
`list` and the refusal paths, since a demo on the machine beats CI evidence alone.

## Status

**GATE 1 — awaiting approval of this plan** (and the `tsx` choice). Nothing is
implemented on this branch yet beyond this document.
