# #458 — A refusal must name itself where an operator looks

**Goal:** a cost-gate refusal stops reporting as Eve's opaque `MODEL_SELECTION_FAILED` and
starts naming its own reason, period and category on a surface the factory emits.

**Architecture:** one typed refusal thrown from the gate, carrying the governor's decision,
plus one structured log line emitted at the gate — both reusing conventions the codebase
already has instead of inventing a parallel reporting path.

**Tech stack:** TypeScript, vitest, the existing `CostGovernorRefusal` union,
`CostRefusedError`, `recordCostRefusal`/`cost_refusal` run-ledger field, and the repo's
injectable `log` sink idiom.

---

## Root cause (verified)

Two paths reach the gate, and they report very differently.

**The runner path is already diagnosed.** `scripts/dark-factory-runner.ts` calls
`runGovernedAgentCall`, which on a refusal (a) records the machine-readable code on the run —
`recordCostRefusal(history, { runId, code })` appends a `run.terminal`/`failed` event with
`costRefusal: "budget_exceeded" | "budget_unavailable" | ...` — and (b) throws
`CostRefusedError`, which carries `reason`.

**The deployed-agent path is not, and it is the one that failed.** `agent/agent.ts` builds its
gate with `createCostGate`, and `governed-model.ts` runs it in `step.started`. On a refusal
`cost-gate.ts` does this:

```ts
throw new Error(
  `${category} cost gate refused the call${forTenant}: ${decision.reason ?? "budget_unavailable"}`,
);
```

Three things are wrong with that line, in order of cost:

1. It is a **bare `Error`** — a caller cannot ask `error.reason`; only a string carries the
   reason, and nothing else does.
2. `decision.error` — the store's own message, e.g. *"Reservation would exceed the configured
   budget cap."* — is **dropped entirely**.
3. Nothing **logs**. Eve owns the failure code it reports, so the refusal's own words never
   reached the eval output, the run log or the deployment log. In the 2026-10-24 incident the
   only way to learn the cause was to query `df_cost_budgets` by hand.

## Intended fix

**A — one typed refusal that carries the decision.** Define a single `CostRefusedError` in
`cost-governor.ts` — the module that owns `CostGovernorRefusal` and produces the decision:

```ts
export class CostRefusedError extends Error {
  readonly reason: CostGovernorRefusal;
  readonly period?: string;
  readonly category?: CostCategory;
  readonly tenantId?: string;
  readonly storeError?: string;
  constructor(input: { reason; period?; category?; tenantId?; storeError? }) { ... }
}
```

`cost-gate.ts` throws it, populated from the decision instead of a bare `Error`.
`governed-agent-call.ts` currently declares its own narrower `CostRefusedError`; that class
moves to the governor and the module **re-exports** it, so `tests/dark-factory/governed-agent-call.test.ts`
and the runner keep their import path and their `toBeInstanceOf` assertions unchanged.

**B — the refusal logs itself, once, at the gate.** `createCostGate` gains an injectable sink
in the idiom the repo already uses (`log?: (message: string) => void`, defaulting to
`console.warn`), and the refusal emits one line an operator can find with a single grep, in the established
`[dark-factory]` convention:

```text
[dark-factory] cost gate refused the call category=orchestrator period=2026-10 reason=budget_exceeded store="Reservation would exceed the configured budget cap."
```

That is the surface that turns the next incident from a database query into a log grep: it
lands in the deployed function's runtime logs, where an operator actually looks.

**C — keep the runner's record shape.** No behaviour change there, but the relocation in A is
exactly the kind of edit that can silently break `costRefusal` persistence, so a guard test
pins it.

## What this does NOT do, stated plainly

- **The eval output itself stays `MODEL_SELECTION_FAILED`.** That code is Eve's, emitted by the
  runtime when a dynamic resolver throws; nothing inside this repo can change what
  `eve eval` prints. The issue's acceptance is met by naming the reason on the run (runner
  path) and in the structured log line (agent path), not by rewriting Eve.
- It does not prevent refusals. It makes them self-describing.

## Tasks

Each code task is a RED/GREEN pair per `test-driven-development`, committed as
`test(458): … RED` then `feat(458): … GREEN`.

### Task 1 — RED: a refused admission throws a typed error carrying the decision

**Files:** `tests/dark-factory/cost-gate.test.ts`

Add a case with an injected refusing governor (`{ admit: vi.fn(async () => ({ admitted: false, reason: "budget_exceeded", period: "2026-10", error: "Reservation would exceed the configured budget cap." })) }`):

```ts
await expect(gate?.admit()).rejects.toBeInstanceOf(CostRefusedError);
```

plus assertions on `reason`, `period` and that the message contains the store's own error
text. Assert the *fields*, not the message alone — a bare `Error` carrying the reason in its
string is exactly the defect.

Expected RED: the rejection is an `Error`, not a `CostRefusedError`; the store error text is
absent from the message.

### Task 2 — GREEN: one enriched refusal, thrown from the gate

**Files:** `agent/lib/dark-factory/cost-governor.ts`, `agent/lib/dark-factory/cost-gate.ts`,
`agent/lib/dark-factory/governed-agent-call.ts`

Move the class to the governor, throw it enriched from `cost-gate.ts`, re-export it from
`governed-agent-call.ts` and delete the local duplicate. Include `decision.error` in the
message so the string form is complete on its own.

Verify: the existing assertion `rejects.toThrow(/developer cost gate refused/)` in
`tests/dark-factory/cost-gate.test.ts` still passes — the message keeps its leading words, so
no consumer string breaks.

### Task 3 — RED: the refusal logs one structured line

**Files:** `tests/dark-factory/cost-gate.test.ts`

Inject a sink and assert exactly one call, containing `reason=budget_exceeded`,
`category=orchestrator`, the period, and the store's message:

```ts
const log = vi.fn();
const gate = createCostGate({ ...BASE, governor: refusingGovernor, log });
await expect(gate?.admit()).rejects.toThrow();
expect(log).toHaveBeenCalledTimes(1);
expect(log.mock.calls[0][0]).toMatch(/reason=budget_exceeded/);
```

Expected RED: `log` is never called (zero calls).

Also assert an **admitted** call logs nothing — the sink must not narrate success.

### Task 4 — GREEN: the sink and the line

**Files:** `agent/lib/dark-factory/cost-gate.ts`

`log` option, `console.warn` default, one line at the refusal, `[dark-factory]` prefix, and
`store=` only when the store supplied one. Re-run the case from Task 3.

### Task 5 — guard: the runner's refusal record still lands

**Files:** `tests/dark-factory/governed-agent-call.test.ts`

The existing file already asserts a refusal is recorded on the run and throws
`CostRefusedError`. Add one assertion that the recorded `costRefusal` code equals the reason
the governor returned, so the class relocation cannot quietly change the persisted code. This
is a **GUARD, not a bug fix** — say so in the test comment.

### Task 6 — ADR 0058 and its index entry

**Files:** `docs/adr/0058-a-refusal-names-itself-where-an-operator-looks.md`,
`docs/adr/README.md`

Record: why the error carries fields rather than only a message, why the gate logs in addition to
throwing, why `console.warn` rather than `console.error`, and the honest limitation that Eve
owns the eval-side code. 0057 is the highest ADR on `main`, so this is 0058.

### Task 7 — gates before the PR

```bash
npx vitest run                                        # full suite
npx tsc --noEmit --incremental false
FILES=$(git diff --name-only origin/main...HEAD | grep -E '\.(ts|tsx|md|json|yml|yaml|css)$')
npx cspell@9.1.1 -c .cspell.json $FILES               # CI pins 9.1.1
npx -y markdownlint-cli@0.45.0 -c <lint-config.json> <changed .md>
npx -y markdown-table-formatter@1.6.1 --check <changed .md>
DF_PLATFORM_PROVIDER=generic npm run build            # first run may nudge once; retry (#459)
```

## Files likely to change

| File                                                              | Change                                                                                |
|-------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| `agent/lib/dark-factory/cost-governor.ts`                         | the `CostRefusedError` class (fields: reason, period, category, tenantId, storeError) |
| `agent/lib/dark-factory/cost-gate.ts`                             | throw the enriched error; the `log` sink; the one structured line                     |
| `agent/lib/dark-factory/governed-agent-call.ts`                   | re-export the class; delete the local duplicate                                       |
| `tests/dark-factory/cost-gate.test.ts`                            | typed-error case, log case, admitted-logs-nothing case                                |
| `tests/dark-factory/governed-agent-call.test.ts`                  | guard on the persisted refusal code                                                   |
| `docs/adr/0058-a-refusal-names-itself-where-an-operator-looks.md` | new ADR                                                                               |
| `docs/adr/README.md`                                              | index entry                                                                           |

No new module under `agent/lib/dark-factory/` and no new environment variable, so the docs
catalog row and the `.env.example` coverage guard are untouched.

## Validation

- The new cases watched failing then passing, including "an admitted call logs nothing".
- Full suite green with no new failures; `tsc --noEmit --incremental false` clean; the build
  gate on the first successful run.
- Non-vacuity: remove the log call and confirm Task 3 fails; revert the throw to a bare
  `Error` and confirm Task 1 fails; restore both.
- Existing assertions that must survive untouched: `rejects.toThrow(/developer cost gate
  refused/)` and both `toBeInstanceOf(CostRefusedError)` cases.
- The production-shaped check: a refusal now produces one line naming
  `reason=budget_exceeded` with the store's message, which is exactly what the 2026-10-24
  incident lacked.

## Risks and open questions

- **`console.warn` versus `console.error`.** A refusal is a deliberate control doing its job,
  but it does fail a turn. Warning level keeps the error channel meaningful; if you would
  rather refusals raise to error level, say so and I will change the default.
- **The sink is injectable but nothing injects it yet.** `agent/agent.ts` gets the default, so
  the deployed agent logs to the platform's log sink. A later change could route it to a
  structured logger without touching the gate.
- **Log volume.** One line per refusal, and a refused turn stops, so refusals are rare and
  self-limiting by construction.
- **Message-shape compatibility.** The leading words of the refusal message are asserted by an
  existing test; I am keeping them and appending the store's message, so the change is
  additive. Any consumer matching on the full old string would need updating — none found.
- **The eval surface stays Eve's.** If you want the reason visible in `eve eval` output, that
  is an Eve-side limitation to raise separately; I will not fake it by re-coding the failure.
