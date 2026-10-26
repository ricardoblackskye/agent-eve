# Plan — operator CLI to manage Dark Factory cost budgets (`df:cost-budget`)

- **Date:** 2026-10-26
- **Branch:** `feat/df-cost-budget-cli`
- **Issue:** none yet (follow-up from #478). Offer to file one.

## Goal

Give operators a supported, in-code way to inspect and adjust the Dark Factory
LLM cost budgets — in particular to **top up a spent cap** (the #478 stopgap)
— without hand-writing SQL in Supabase. One command drives both backends.

## Context

- Budgets live in `df_cost_budgets`, keyed by
  `costBudgetId(period, category, tenantId)` (`'2026-10|orchestrator'` for a
  global row). `tenant_id IS NULL` is the GLOBAL budget.
- The gate refuses when `spent_usd + reserved_usd + estimate > cap_usd`
  (`cost-budget-store-postgres.ts` → `reserve()`).
- `admit()` uses the ENV cap only to (a) refuse `not_configured` and (b)
  INSERT the row once (`ensureBudget`, `ON CONFLICT DO NOTHING`). So changing
  the Vercel env var does **not** change an existing row's `cap_usd` — the row
  is the source of truth for the ceiling. That is exactly the gap this CLI fills.
- The store seam (`CostBudgetStore`) is implemented by four providers
  (console / memory / sqlite / postgres) and has no cap-adjust primitive today:
  `ensureBudget` creates-if-absent and never updates.

## Approach

1. **Add a store primitive, not ad-hoc SQL.** `setBudgetCap(period, category,
   capUsd, tenantId?)` on `CostBudgetStore`, implemented by all four providers:
   - upsert: create the row if absent (`spent/reserved/callCount = 0`), else
     update **`cap_usd` only**, preserving the spend record;
   - validate category (`isCostCategory`) and cap (finite, `>= 0`) — a bad
     argument is a blocked result, never a write;
   - console provider stays fail-closed (`blocked`), like its siblings.
2. **A thin operator CLI** `scripts/df-cost-budget.ts`, wired as
   `npm run df:cost-budget`, mirroring `scripts/df-membership.ts`: driver from
   env via `createCostBudgetStore()`, `loadLocalEnv()` first, prints rows,
   non-zero exit on refusal, `close?.()` in `finally`.

```text
npm run df:cost-budget -- show [--period 2026-10] [--category orchestrator] [--tenant <uuid>]
npm run df:cost-budget -- set  --category orchestrator --cap 100  [--period 2026-10] [--tenant <uuid>]
npm run df:cost-budget -- add  --category orchestrator --amount 50 [--period 2026-10] [--tenant <uuid>]
```

- default period = a concrete `DF_COST_BUDGET_PERIOD`, else the current UTC month
  (reuse `utcMonth`).
- `add` = read current cap → `set` `cap + amount`; prints the delta. (Operator
  CLI, single writer; the read-modify-write is not atomic and the plan says so.)
- refuse when the driver is unset/`console` with an explicit message.

## Tasks (TDD)

1. RED: `tests/dark-factory/cost-budget-set-cap.test.ts` — in-memory provider:
   creates a row; updates an existing cap while **preserving** `spent_usd` /
   `reserved_usd`; rejects a negative / non-finite cap and an unknown category.
2. GREEN: add the type + method to `cost-budget-store.ts`
   (`Console` blocked, `InMemory` upsert).
3. RED/GREEN: same cases against `cost-budget-store-sqlite.ts` (temp file, `close()`).
4. RED/GREEN: postgres adapter `setBudgetCap` — at minimum an integration case
   alongside the existing pg budget tests (skip when no DB, as they already do).
5. RED/GREEN: `scripts/df-cost-budget.ts` — extract pure `parseArgs` /
   `resolvePeriod` / `computeTopUp` helpers and unit-test them (the CLI's
   `main()` is not unit-tested; CI/config is the only full exercise).
6. `package.json` script: `"df:cost-budget": "tsx scripts/df-cost-budget.ts"`.
7. Docs: README operator-commands line; ADR for "cap changes are a store write
   with absolute-set semantics, preserving spend" (and why not `ensureBudget`).

## Files

- `agent/lib/dark-factory/cost-budget-store.ts` (interface + console + memory)
- `agent/lib/dark-factory/cost-budget-store-sqlite.ts`
- `agent/lib/dark-factory/cost-budget-store-postgres.ts`
- `scripts/df-cost-budget.ts` (new)
- `package.json`
- `tests/dark-factory/cost-budget-set-cap.test.ts` (new)
- `docs/adr/00NN-cost-budget-cap-management.md` (new) + index
- `README.md` (operator command)

## Validation

- `npx vitest run tests/dark-factory/cost-budget-set-cap.test.ts` red then green.
- Full suite + `tsc --noEmit` + cspell@9.1.1 + prettier clean.
- Local demo (proves it on the machine): run `show` then `add` against a SQLite
  budget (`DF_COST_BUDGET_DRIVER=sqlite DF_COST_BUDGET_DB_PATH=...`) and show the
  cap rise while `spent_usd` is unchanged. CI/the operator run it against the
  Supabase DSN via `DF_COST_BUDGET_DATABASE_URL` (never pasted into chat).

## Risks / open questions

- **Scope:** cap management only (`show`/`set`/`add`). No `spent_usd` reset —
  zeroing spend erases the month's accounting and is the wrong kind of top-up;
  add it later only if asked.
- Should this get its own GitHub issue for traceability? Offer to file one.
- The `add` read-modify-write is not atomic; acceptable for a manual operator
  command, and stated in the CLI help.
