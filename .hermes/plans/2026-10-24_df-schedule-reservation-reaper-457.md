# #457 — Schedule the stale-reservation reaper

**Goal:** a reservation that no process can settle is released without a human running a
script, so the cost ceiling cannot be silently eroded into `MODEL_SELECTION_FAILED` refusals.

**Architecture:** schedule the reaper at the one seam every admitting process already
shares — `createCostGovernor().admit()` — throttled per governor instance, best-effort,
with a TTL that is stated and justified.

**Tech stack:** TypeScript, vitest (fake timers), the existing
`CostBudgetStore.reapStaleReservations(ttlMs)` shipped in #446, and
`InMemoryCostBudgetProvider` as the store under test.

---

## Root cause (verified)

The reaper exists but no production caller invokes it. On `main`:

```text
$ git grep -n reapStaleReservations origin/main -- ':!tests/*'
agent/lib/dark-factory/cost-budget-store-postgres.ts:312   (definition)
agent/lib/dark-factory/cost-budget-store-sqlite.ts:301     (definition)
agent/lib/dark-factory/cost-budget-store.ts:105,135,300    (interface + in-memory impl)
```

The consequence was measured on the row production reads:

```text
df_cost_budgets   2026-10 orchestrator  cap=30 spent=16.8570 reserved=12.6355 used=29.4925 (98%)
df_cost_reservations WHERE settled = FALSE:  n=27 usd=12.6355 oldest=2026-10-13 newest=2026-10-23
```

A turn reserves ~$4.86, so `29.4925 + 4.86 > 30` and every turn was refused. Only the two
evals that call a model failed (`smoke`, `auth-valid`); the other seven never reach
`step.started`. ADR 0054 Slice A settles the reservations JS *can* observe — a completed
call, a thrown call, a stream read to its end. Slice B exists precisely for the case no JS
can observe: a killed process, a deployment swap, a platform timeout. Slice B has no caller,
so that case has never been covered in any deployed environment.

## Intended fix

Reap inside `admit()`, immediately before the reservation is taken.

- A per-governor closure value (`lastReapMs`) tracks the last reap, so each governor
  instance is independent and tests need no module-global reset.
- On `admit()`, when `now - lastReapMs >= REAP_INTERVAL_MS`, call
  `store.reapStaleReservations(RESERVATION_TTL_MS)` and record `now`.
- The initial value is `0`, so the **first** admission in a process reaps. A fresh process
  is a fresh chance to heal, and in a serverless runtime cold starts are the schedule.
- The reap is **best-effort**: a rejection/throw is swallowed. A store that cannot reap must
  still report its own admission error rather than crashing the turn on a side errand.
- Reaping **before** `store.reserve` means freed budget is available to the very call that
  triggered it — the self-healing property the production incident demanded.

Two constants sit next to the seam in `cost-governor.ts`, with their reasoning in a comment:

```ts
/** A reservation is a SINGLE model call. 30 minutes is far beyond any legitimate call
 *  (Vercel's maximum function duration is 900 s), and far shorter than the 11 days a
 *  stranded one survived in production. */
export const RESERVATION_TTL_MS = 30 * 60 * 1000;

/** At most one reap per process per interval: one extra store round trip, not one per turn. */
export const REAP_INTERVAL_MS = 10 * 60 * 1000;
```

## Why the admission path, and not a cron

- The leak is created only by processes that **admit**. Reaping on the admission path puts
  the release exactly where the stranded reservation came from, in every process that can
  create one: the deployed agent (`cost-gate.ts`), the runner, the PR reviewer.
- It needs no new deployment surface: no API route, no `CRON_SECRET`, no schedule to keep
  in sync, and no Vercel-Cron Production-only restriction.
- A cron route could not see the runner's local SQLite store; the governor seam covers both
  backends because it only knows the `CostBudgetStore` interface.

## What this does not fix

- **Genuine spend growth against a cap.** `spent_usd` is real and untouched; if the factory
  legitimately spends past its ceiling the refusal is correct. That is cap tuning, not a leak
  (see #453).
- **A stranded reservation is released only when some process next admits after the TTL.**
  If nothing admits for hours, nothing is competing for the budget either, so the delay is
  harmless by construction.
- **Observability.** This change does not make a refusal explainable in an eval — that is
  #458, which follows this issue.

## Tasks

Each task is one RED/GREEN pair per `test-driven-development`, committed separately as
`test(df): … RED` and `feat(df): … GREEN`.

### Task 1 — RED: a stale reservation is released by the next admission

**Files:**
- Modify: `tests/dark-factory/cost-governor.test.ts` (add a `describe` block for #457)

**Step 1: write the failing test.** Build a governor on `InMemoryCostBudgetProvider` and
prove the behaviour end to end, not the mechanism:

```ts
describe("scheduling the reaper (#457)", () => {
  it("releases a stale reservation on the next admission, and admits that call", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryCostBudgetProvider();
      const governor = createCostGovernor(store, ENV);

      await governor.admit({ category: "orchestrator", model: MODEL, inputTokens: 1_000, outputTokens: 1_000 });
      const [afterFirst] = await governor.status();
      expect(afterFirst.reservedUsd).toBeGreaterThan(0);

      // The process that took that reservation is killed: nothing settles it.
      vi.advanceTimersByTime(RESERVATION_TTL_MS + 1);

      const decision = await governor.admit({ category: "orchestrator", model: MODEL, inputTokens: 1_000, outputTokens: 1_000 });

      expect(decision.admitted).toBe(true);
      const [afterSecond] = await governor.status();
      // only the SECOND reservation remains: the stranded one was released
      expect(afterSecond.reservedUsd).toBeCloseTo(decision.estimatedUsd!, 10);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

**Step 2: run it and confirm it fails for the right reason.**

```bash
npx vitest run tests/dark-factory/cost-governor.test.ts -t "releases a stale reservation"
```

Expected RED: `reservedUsd` is the SUM of both reservations (the stale one was never
released), so the assertion fails on a number, not on a missing export.

**Step 3: commit the RED** (test only, with the minimal `RESERVATION_TTL_MS` stub export if
the import would otherwise abort collection — see the shared-file split procedure in the
workflow skill).

### Task 2 — GREEN: reap before reserving, throttled

**Files:**
- Modify: `agent/lib/dark-factory/cost-governor.ts`

**Step 1: minimal implementation.** Add the constants, and in `admit()` before the
`store.reserve(...)` call:

```ts
let lastReapMs = 0;                       // per-governor, inside createCostGovernor
// ...inside admit(), immediately before store.reserve(...):
const nowMs = Date.now();
if (nowMs - lastReapMs >= REAP_INTERVAL_MS) {
  lastReapMs = nowMs;
  try {
    await store.reapStaleReservations(RESERVATION_TTL_MS);
  } catch {
    // The reaper is a backstop, never a precondition: a store that cannot reap
    // must still be able to report its own admission refusal.
  }
}
```

**Step 2: run the test and the full suite.**

```bash
npx vitest run tests/dark-factory/cost-governor.test.ts
npx vitest run                                        # no regressions
npx tsc --noEmit --incremental false                  # types (vitest does not type-check)
```

**Step 3: commit the GREEN.**

### Task 3 — a FRESH reservation is never reaped

Guards the case the TTL exists for: reaping a live call would let a slow turn overspend.

```ts
it("does not release a reservation younger than the TTL", async () => { /* advance < TTL */ });
```

Assert `reservedUsd` is still the sum, and that the store received the exported
`RESERVATION_TTL_MS` (so the constant — not a literal at the call site — is what governs).

### Task 4 — the throttle bounds the work per process

Fake timers, two admissions inside one interval, one admission after it:

```ts
it("reaps at most once per interval, and again once the interval passes", async () => { /* spy on the store */ });
```

Assert the reap call count is 1, then 2 after advancing `REAP_INTERVAL_MS`. This is the test
that stops the change becoming a store round trip on every turn.

### Task 5 — a failing reap must not block admission

```ts
it("admits the call when the reaper itself throws", async () => { /* reapStaleReservations rejects */ });
```

Assert `decision.admitted === true`. A backstop that can veto the thing it protects is worse
than no backstop.

### Task 6 — control: an admission with nothing stale is unchanged

Assert that with no stale reservations the admission still returns a reservation id and the
budget row equals the estimate — the existing Task-1 assertion in the untouched first
`describe` block already covers this, so name it explicitly rather than adding a duplicate.

### Task 7 — ADR 0057 and the index

**Files:**
- Create: `docs/adr/0057-a-stale-reservation-is-reaped-on-admission.md`
- Modify: `docs/adr/README.md` (index entry; an orphan ADR fails `adr-integrity`)

Record the decision (schedule on the admission path rather than a cron), the stated TTL and
why it is a guess, and the consequence that a stranded reservation survives until the next
admission after the TTL. Take the number from the current `main`: 0056 is the highest today,
so this is 0057.

### Task 8 — gates before the PR

```bash
npx vitest run                                        # full suite, exit 0
npx tsc --noEmit --incremental false                   # clean
FILES=$(git diff --name-only origin/main...HEAD | grep -E '\.(ts|tsx|md|json|yml|yaml|css)$')
npx cspell@9.1.1 -c .cspell.json $FILES                # CI pins 9.1.1; local bare npx resolves v10
npx -y markdownlint-cli@0.45.0 -c '{"default":false,"MD040":true,"MD026":true}' <changed .md>
npx -y markdown-table-formatter@1.6.1 --check <changed .md>
DF_PLATFORM_PROVIDER=generic npm run build             # the build-only break vitest cannot catch
```

## Files likely to change

| File                                                          | Change                                                             |
|---------------------------------------------------------------|--------------------------------------------------------------------|
| `agent/lib/dark-factory/cost-governor.ts`                     | reaper call in `admit()`, the throttle, the two exported constants |
| `tests/dark-factory/cost-governor.test.ts`                    | new `describe` block for #457                                      |
| `docs/adr/0057-a-stale-reservation-is-reaped-on-admission.md` | new ADR                                                            |
| `docs/adr/README.md`                                          | index entry for 0057                                               |

No new module under `agent/lib/dark-factory/`, so the `docs/pages/` catalog row is untouched.
No new environment variable, so `.env.example` and the env-coverage guard are untouched.

## Validation

- The unit tests above, watched failing then passing, including the exact-TTL boundary.
- Full suite green with no new failures; `tsc --noEmit --incremental false` clean.
- The build gate, because this change is in the module the agent imports at startup.
- **Real proof on the production row** (the same read-only audit used to find the incident):
  after deploying, a stranded reservation older than the TTL disappears at the next
  admission, and `reserved_usd` returns to the value of live reservations only.
- Non-vacuity: mutate the reap call away and confirm Task 1's test fails; restore and re-run.

## Risks and open questions

- **The TTL is a guess and is stated as one** (ADR 0054 already says so). Too short reaps a
  live call and lets a slow turn overspend; too long strands budget. 30 minutes is chosen to
  sit far outside any single call's duration. Flag if you would rather it be tunable.
- **Constants, not env vars.** A tuning knob would need `DF_COST_RESERVATION_TTL_MINUTES`
  plus an `.env.example` row and the env-coverage guard. My call is constants now, an env
  override only if you want to tune without deploying. Say the word and I will add it.
- **One extra store round trip per process per interval**, and one per cold start. Bounded
  and idempotent; the store's reap is a no-op when nothing is stale.
- **A reaped-then-settled race is already safe**: `settle()` opens with
  `if (reservation.settled) return { ok: true }`, so a late settle after a reap cannot double
  charge. No change needed, but Task 3's boundary test is what keeps it honest.
- **This does not restore the preview cost gate.** Preview stays on `console`, so preview
  evals will not exercise the reaper. Verification of this fix is unit tests plus the
  production-row audit, not a green preview eval.
