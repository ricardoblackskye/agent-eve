/**
 * Dark Factory - operator CLI for LLM cost budgets (follow-up to #478).
 *
 * The supported way to inspect a cap and to TOP IT UP once a period has been
 * spent - the #478 failure mode, where the orchestrator cap was exhausted by
 * real traffic and every gated eval was refused with `budget_exceeded`.
 *
 * The driver comes from `DF_COST_BUDGET_DRIVER`, so one command works against
 * the local SQLite database or the deployed Postgres.
 *
 *   npm run df:cost-budget -- show [--period 2026-10] [--category orchestrator] [--tenant <uuid>]
 *   npm run df:cost-budget -- set  --category orchestrator --cap 100   [--period 2026-10]
 *   npm run df:cost-budget -- add  --category orchestrator --amount 50 [--period 2026-10]
 *
 * WHY THIS WRITES THE ROW: the cap the GATE reads is `df_cost_budgets.cap_usd`.
 * The `DF_COST_BUDGET_*_USD` env var only seeds that row when it is first
 * created (`ensureBudget` is `ON CONFLICT DO NOTHING`), so changing the env on
 * an existing deployment does NOT move the ceiling. `setBudgetCap` does, and
 * preserves `spent_usd` / `reserved_usd` / `call_count` so the period's
 * accounting survives the top-up.
 *
 * Fails closed: an unconfigured driver refuses rather than appearing to succeed.
 */

import type { CostBudget } from "../agent/lib/dark-factory/cost-budget";
import {
  computeToppedUpCap,
  parseCostBudgetArgs,
  resolveBudgetPeriod,
  toCostCategory,
} from "../agent/lib/dark-factory/cost-budget-admin";
import {
  createCostBudgetStore,
  type CostBudgetStore,
} from "../agent/lib/dark-factory/cost-budget-store";
import { loadLocalEnv } from "./load-env";

const USAGE = `Usage:
  df:cost-budget show [--period <YYYY-MM>] [--category <category>] [--tenant <uuid>]
  df:cost-budget set  --category <category> --cap <usd>    [--period <YYYY-MM>] [--tenant <uuid>]
  df:cost-budget add  --category <category> --amount <usd> [--period <YYYY-MM>] [--tenant <uuid>]

Categories: orchestrator, developer, tester, pr-review
Period defaults to DF_COST_BUDGET_PERIOD when concrete, else the current UTC month.
No --tenant targets the global (tenant-less) budget.`;

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

/** One row, with the headroom the gate actually computes against. */
function formatBudget(budget: CostBudget): string {
  const reserved = budget.reservedUsd ?? 0;
  const headroom = budget.capUsd - budget.spentUsd - reserved;
  return (
    `${budget.period} ${budget.category}` +
    `${budget.tenantId ? ` tenant=${budget.tenantId}` : ""}` +
    ` cap=$${budget.capUsd} spent=$${budget.spentUsd} reserved=$${reserved}` +
    ` headroom=$${headroom} calls=${budget.callCount}`
  );
}

async function readRows(
  store: CostBudgetStore,
  period: string,
  tenantId?: string,
): Promise<CostBudget[]> {
  const read = tenantId
    ? await store.listTenantBudgets(tenantId, period)
    : await store.listBudgets(period);
  if (!read.ok)
    throw new Error(read.error ?? "Could not read the cost budget store.");
  return read.value;
}

async function main(): Promise<void> {
  // The app reads .env.local; a bare tsx run would not, so without this the CLI
  // and the app can disagree about which store - and which database - is in play.
  loadLocalEnv();

  const { command, flags } = parseCostBudgetArgs(process.argv.slice(2));
  const period = flags.period ?? resolveBudgetPeriod(process.env);
  const tenantId = flags.tenant;
  const store = createCostBudgetStore();

  try {
    switch (command) {
      case "show": {
        const rows = await readRows(store, period, tenantId);
        const category = flags.category;
        const filtered = category
          ? rows.filter((row) => row.category === toCostCategory(category))
          : rows;
        if (filtered.length === 0) {
          console.log(
            `no budget rows for period ${period}${tenantId ? ` tenant=${tenantId}` : ""}`,
          );
          break;
        }
        for (const budget of filtered) console.log(formatBudget(budget));
        break;
      }

      case "set":
      case "add": {
        const category = toCostCategory(requireFlag(flags, "category"));
        const [current] = (await readRows(store, period, tenantId)).filter(
          (row) => row.category === category,
        );
        const currentCap = current?.capUsd ?? 0;

        // `set` is an absolute ceiling; `add` is a relative top-up. Both land in
        // the same store write, so the validation lives in one place.
        const nextCap =
          command === "set"
            ? Number(requireFlag(flags, "cap"))
            : computeToppedUpCap(
                currentCap,
                Number(requireFlag(flags, "amount")),
              );

        const written = await store.setBudgetCap(
          period,
          category,
          nextCap,
          tenantId,
        );
        if (!written.ok)
          throw new Error(written.error ?? "Could not set the budget cap.");

        console.log(`before: ${current ? formatBudget(current) : "(no row)"}`);
        console.log(
          `after:  ${written.value ? formatBudget(written.value) : `${period} ${category} cap=$${nextCap}`}`,
        );
        break;
      }

      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await store.close?.();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
