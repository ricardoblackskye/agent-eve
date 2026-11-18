# The gate's flake is seven slow tests, not a random machine — implementation plan

**Goal:** make the pre-push gate deterministic by removing the flake's actual cause: a handful of
tests whose own work sits within 2x of vitest's 5-second default.

**Issue:** ricardoblackskye/agent-eve 690 (found while running 673/674/675/676/679/681 in one session).

**Architecture:** the flake is not random. The suite's seven slowest tests ARE the set that fails, so
the fix is to remove the avoidable cost (one test's process spawns) and to size the timeout from
measured data rather than the framework default.

**Tech stack:** TypeScript, Vitest 4, Postgres 16, Node.

---

## Root cause (measured, not inferred)

Three runs of the identical suite on identical input gave `3690 passed`, then `6 failed`, then
`3694 passed`. Every failure was `Error: Test timed out in 5000ms` with **zero assertion failures**,
and each passed in isolation (`active-run-claim` 11/11; the four Postgres files 44/44 in 5.68s).

The run's JSON report carries per-test durations, which turns "probably load" into a list. These are
the seven slowest tests in all 3712 — and the failing run's failures were exactly this set:

```text
5116ms  FAILED   vault-proof-redaction   masks every occurrence, not just the first
4892ms  passed   vault-proof-redaction   leaves text untouched for an empty or absent secret
3990ms  passed   vault-proof-redaction   masks the secret while keeping the proof's evidence
2798ms  passed   run-history-postgres    atomically persists an idempotent delivery
2584ms  passed   active-run-claim        refuses a SECOND delivery, naming the existing run
2497ms  passed   retire-run-claim        retires a PARKED run's claim
2048ms  passed   record-run-cost         records a cost that reads back on the run
```

Nothing else in the suite is within 2x of the bar. So the bar is not "usually fine" — **the slowest
test is already AT it (5116ms against 5000ms), and the other six are 1.8x to 2.4x under**.

The load factor is real but modest, measured from the same files:

```text
green run: retire-run-claim 5834ms, active-run-claim 5678ms, record-run-cost 5595ms
red run:   retire-run-claim 9433ms, active-run-claim 9863ms, record-run-cost 9861ms   (~1.7x)
```

1.7x on a test at 2.0-2.8s crosses 5s; 1.7x on the vault tests crosses it with room to spare.

### Why the vault suite costs what it does

`tests/dark-factory/vault-proof-redaction.test.ts` calls `probeRedact()` from each of three tests, and
`probeRedact()` calls `pythonBin()` every time. `pythonBin()` probes `python3` and then `python`, so
**each test spawns three child processes** to obtain one probe result that all three tests read:

```ts
function pythonBin(): string {
  for (const candidate of ["python3", "python"]) {
    try { execFileSync(candidate, ["--version"], { stdio: "ignore" }); return candidate; } catch {}
  }
  throw new Error("no python interpreter found");
}

function probeRedact(): Record<string, unknown> {
  const stdout = execFileSync(pythonBin(), ["-c", snippet, SCRIPT_PATH], { encoding: "utf8" });
  return JSON.parse(stdout);
}
```

Measured on this machine, spawns are not cheap:

```text
python3 --version    0.610s
python --version     0.342s
the probe itself     0.754s
```

That is ~1.7s per test of pure process creation, three times over, for one probe — and it is why the
suite takes 14s for eight tests when green.

### What this means for the issue's own suggestions

- *Give the DB tests their own database* — done by 689, which moved the suites off the launcher's
  ledger. That removed the **collision**; it did nothing about this **contention**, which is among the
  suites themselves.
- *Serialise the DB files* — **closed off, and it should be.** ADR 0052 records serialization as
  "designed and deliberately not needed", and `pg-suite-isolation.test.ts` has a guard asserting the
  fast path is not paid for (`fileParallelism !== false`, `maxWorkers !== 1`, no per-file exclusion or
  sequencing of the Postgres suites). Proposing it would fail that guard, which is the guard working.
- *Raise the timeout* — correct for the residual, and the plan does it, but sizing it is the second
  half of the job rather than the whole of it.

## Intended fix

**Leg 1 — remove the avoidable cost.** Resolve the interpreter once per file instead of once per test,
and run the probe once for the three assertions that read it. Expected: that file falls from ~5s
off-peak (14s under load) to ~1.1s, deleting the three worst offenders from the suite.

**Leg 2 — size the bar from measurement.** Set `testTimeout` in `vitest.config.ts` to a value with real
headroom over the measured worst case, and record in an ADR why 5s was never a decision. This is the
leg that covers the four Postgres tests, whose own cost is not obviously avoidable.

**Not a leg — do not serialize.** See above; ADR 0052 and its guard are the authority.

## Settled decisions

**D1 — fix the cost before touching the bar.** A timeout raise alone would have made the gate green
while leaving a test that spends 1.7s of every 2s in process creation. The measured data says the
avoidable part is real and large, so it goes first.

**D2 — the timeout is global, not per file.** A per-file override would have to be repeated for each
slow suite and can drift out of step with the next one; one value in `vitest.config.ts` with the
measurement in a comment is one mechanism and one explanation. The cost is honest and stated: a
genuinely hung test now takes the new value to fail instead of 5s.

**D3 — an ADR, because the value invites "why 20s?".** ADR 0088 decided what a disposable database is;
this decides what the per-test bar is sized from. Two small records beat one that conflates them.

**D4 — Leg 1 is a behaviour-preserving refactor with no invented RED.** There is no meaningful failing
test for "the probe ran three times instead of once": the oracle is the eight existing assertions plus
the measured before/after, which is the case `ai-sdlc-workflow` already covers for mechanical changes.
Manufacturing a contrived RED here would be worse than saying so.

## Tasks

### Task 1 — measure the current cost, so the change has a baseline

**Files:** none (measurement)

```bash
npx vitest run tests/dark-factory/vault-proof-redaction.test.ts
```

Record the file duration and the three per-test durations. Expect ~14s under load, ~5s idle, with a
single test at the 5000ms boundary. Keep the numbers for the PR body.

### Task 2 — Leg 1: resolve the interpreter once, probe once

**Files:** `tests/dark-factory/vault-proof-redaction.test.ts`

Hoist the interpreter resolution to module scope (a memo) and move `probeRedact()` into a `beforeAll`
shared by the three assertions:

```ts
/** Resolved once: probing costs a process spawn, and the answer cannot change mid-run. */
let python: string | undefined;
function pythonBin(): string {
  python ??= (() => {
    for (const candidate of ["python3", "python"]) {
      try { execFileSync(candidate, ["--version"], { stdio: "ignore" }); return candidate; } catch {}
    }
    throw new Error("no python interpreter found - ... cannot be executed");
  })();
  return python;
}

let probe: Record<string, unknown>;
beforeAll(() => { probe = probeRedact(); });
```

Each test then asserts its own fields of `probe`. The three assertions are unchanged; only where the
value comes from changes. Keep the doc comment's substance — the guard shape (pure `findLeaks`, an
integration test, a mutation test) is the point of the file and must survive the edit.

**Verify:** the same eight tests pass, and the file's duration collapses.

```bash
npx vitest run tests/dark-factory/vault-proof-redaction.test.ts   # expect 8 passed, ~1s
```

### Task 3 — Leg 2: size the bar, with the measurement recorded

**Files:** `vitest.config.ts`, `docs/adr/0089-a-test-timeout-is-sized-from-measurement.md` (new),
`docs/adr/README.md`

```ts
    // #690: sized from measurement, not from the framework default. The suite's slowest tests sat at
    // 2.0-2.8s with one AT the 5000ms default (5116ms), and a loaded run stretches a file ~1.7x - so
    // the gate went red or green on identical input. The worst case that survives Leg 1 measures
    // 2798ms, so the bar is 7x that. It is a safety net, not a latency budget: a real hang still
    // fails, just later.
    testTimeout: 20_000,
```

The ADR records: the measured set, the load factor, why serialization was not the answer (ADR 0052),
and that this is a safety net rather than a latency target.

**Verify:** the suite passes; the value's comment quotes the numbers.

```bash
npx vitest run tests/dark-factory/ --reporter=default 2>&1 | tail -12
```

### Task 4 — prove the flake is gone, under load

**Files:** none (measurement)

The original flake needed a loaded machine, so reproduce one rather than hoping. Run the Postgres
files and the vault file while the box is busy, and take the slowest test's duration from the report:

```bash
npm run test:coverage -- --exclude 'tests/env-example-coverage.test.ts'
python -c "import json,collections; r=json.load(open('coverage/vitest-report.json')); \
rows=sorted(((a['duration'],a['status'],f['name'].split('/')[-1]) for f in r['testResults'] \
for a in f['assertionResults']), reverse=True); [print(x) for x in rows[:8]]"
```

**Acceptance:** the slowest test's duration is reported, and it is comfortably under the new bar — with
the margin stated in the PR, not asserted. If the slowest DB test is still within 2x of the bar, say so
and open the follow-up instead of quietly raising the value again.

### Task 5 — the local gate

The six checks as usual, and note that the DB suite needs the `_test` database 689 introduced:

```bash
export DF_TENANT_TEST_DATABASE_URL="postgres://postgres@localhost:5432/darkfactory_test?sslmode=disable"
export DF_COST_BUDGET_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_RUN_HISTORY_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_USAGE_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_CONTROL_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
npm run test:coverage && npx tsc --noEmit --incremental false && npm run coverage:ratchet
```

## Files likely to change

| File                                                        | Change                                                       |
|-------------------------------------------------------------|--------------------------------------------------------------|
| `tests/dark-factory/vault-proof-redaction.test.ts`          | resolve the interpreter once; one probe for three assertions |
| `vitest.config.ts`                                          | `testTimeout`, sized from the measurement and explained      |
| `docs/adr/0089-a-test-timeout-is-sized-from-measurement.md` | new ADR                                                      |
| `docs/adr/README.md`                                        | index row (one line - compute the padding, never hand-pad)   |
| `.hermes/plans/2026-11-18_gate-flake-timeout-margin-690.md` | this plan                                                    |

## Risks and open questions

**Risks.**

- **A raised timeout can hide a real hang.** It is a safety net, not a latency budget: a test that
  genuinely deadlocks now takes the new value to fail. The ADR must say so, and the value must stay
  modest.
- **The four Postgres tests keep a residual margin.** After Leg 1 their cost is unchanged; this plan
  makes the bar clear them rather than making them cheaper. Their cost is worth a follow-up if the
  user would rather not raise the bar at all.
- **Measuring under load is imperfect.** The original flake needed a busy machine (minikube was at 43%
  of 8 CPUs). Task 4 states the conditions it measured under rather than implying a worst case.

**Review decisions (settled).** All four were answered at review, so the implementation follows them
rather than re-opening them:

1. **One global `testTimeout`**, not per-file overrides - D2 confirmed.
2. **Seven times the worst remaining measured test.** The worst post-Leg-1 measurement is
   `run-history-postgres` at 2798ms, so the bar is `testTimeout: 20_000`. The multiple is the point:
   the value stays tied to a measurement rather than to a round number, and the comment in
   `vitest.config.ts` quotes the arithmetic.
3. **The Postgres tests' own cost is left alone for now.** They clear the raised bar; making them
   cheaper is separate work, not a condition of this one. Recorded so a later reader does not think it
   was missed.
4. **The ADR is in scope** - D3 confirmed. It must state that the bar is a safety net rather than a
   latency target, so a genuinely hung test still fails, only later.

## Out of scope

- Serializing anything: ADR 0052 and the fast-path guard.
- CI worker counts, container resources, or the `_test` database split (689).
- `tests/env-example-coverage.test.ts`'s local-only failure, which is its own pre-existing issue
  (`df-workspaces/` is absent from the walker's `SKIP_DIRS`).
