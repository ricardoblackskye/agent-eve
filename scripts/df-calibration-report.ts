/**
 * Dark Factory — calibration report CLI (#490, epic #453).
 *
 * Reads recorded estimate/actual pairs and prints the SIGNED bias first, then MAE/MAPE by stage and
 * by cost class, plus the multiplicative factor the estimator consumes in v2. See ADR 0074.
 *
 *   npm run df:calibration-report
 *   npm run df:calibration-report -- --period 2026-10
 *   npm run df:calibration-report -- --json --min-samples 5
 *
 * The ACTUAL is the run's recorded usage, summed from the usage ledger per run — the only per-run,
 * per-stage MEASURED source. It deliberately does NOT read `df_plan_estimate_accuracy`, whose actual
 * column reads `df_run_summaries.cost_usd` and is NULL on every run: a report built on that view
 * would look empty rather than unmeasured.
 *
 * The stage expectation is rebuilt from the counts a persisted estimate records — the plan itself is
 * not kept — then normalised to the stored `expectedUsd`, so the parts always sum to the band that
 * was actually published.
 *
 * Below the configured minimum sample size every METRIC is withheld and only the counts are printed.
 * An insufficient sample is a finding, not a failure: the exit code stays 0.
 */

import {
  EXCLUDED_TASK_TYPES,
  buildCalibrationReport,
  resolveMinimumSampleSize,
  type CalibrationPair,
} from "../agent/lib/dark-factory/calibration-report";
import { decomposePlanCostEstimateFromCounts } from "../agent/lib/dark-factory/plan-cost-estimate";
import { createRunHistoryStore } from "../agent/lib/dark-factory/run-history-provider";
import { createUsageStore } from "../agent/lib/dark-factory/usage-store-provider";
import { queryUsage } from "../agent/lib/dark-factory/usage-query";
import { loadLocalEnv } from "./load-env";

const USAGE = `Usage:
  df:calibration-report [--period <YYYY-MM>] [--min-samples <n>] [--json]`;

export interface ParsedArgs {
  period?: string;
  minSamples?: number;
  json: boolean;
}

/** The flags this CLI accepts. Returns `undefined` for an unusable argument. */
export function parseArgs(argv: string[]): ParsedArgs | undefined {
  const parsed: ParsedArgs = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--json") {
      parsed.json = true;
    } else if (token === "--period") {
      const value = argv[i + 1];
      if (!value) return undefined;
      parsed.period = value;
      i += 1;
    } else if (token === "--min-samples") {
      const value = argv[i + 1];
      if (!value || !/^[0-9]+$/.test(value) || Number(value) < 1) return undefined;
      parsed.minSamples = Number(value);
      i += 1;
    } else {
      return undefined;
    }
  }
  return parsed;
}

/** A run's estimate/actual pair, or `undefined` when it carries no estimate for this period. */
async function pairForRun(
  runId: string,
  ledger: ReturnType<typeof createRunHistoryStore>,
  usage: ReturnType<typeof createUsageStore>,
  period?: string,
): Promise<CalibrationPair | undefined> {
  const estimates = await ledger.listPlanEstimates(runId);
  const latest = estimates[estimates.length - 1];
  if (!latest) return undefined;
  if (period && latest.period !== period) return undefined;

  const perRun = await queryUsage(usage, { runId });
  if (!perRun.ok) throw new Error(`the usage ledger could not be read: ${perRun.error ?? "unknown"}`);
  const stages = perRun.report.byTaskType.filter(
    (entry) => !EXCLUDED_TASK_TYPES.includes(entry.taskType),
  );
  const stageActualUsd: Record<string, number> = {};
  for (const stage of stages) stageActualUsd[stage.taskType] = stage.costUsd ?? 0;

  const parts = decomposePlanCostEstimateFromCounts({
    targetFileCount: latest.targetFileCount,
    taskCount: latest.taskCount,
    model: latest.model,
  });
  const partSum = parts.reduce((total, part) => total + part.expectedUsd, 0);
  const scale = partSum > 0 ? latest.expectedUsd / partSum : 0;
  const stageExpectedUsd: Record<string, number> = {};
  for (const part of parts) stageExpectedUsd[part.stage] = part.expectedUsd * scale;

  return {
    runId,
    costClass: latest.costClass,
    confidence: latest.confidence,
    expectedUsd: latest.expectedUsd,
    actualUsd: stages.reduce((total, stage) => total + (stage.costUsd ?? 0), 0),
    stageActualUsd,
    stageExpectedUsd,
  };
}

function money(value: number | undefined): string {
  return value === undefined ? "withheld" : `$${value.toFixed(4)}`;
}

function percentage(value: number | undefined): string {
  return value === undefined ? "withheld" : `${value.toFixed(1)}%`;
}

async function main(): Promise<number> {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    return 2;
  }

  const minimumSampleSize = args.minSamples ?? resolveMinimumSampleSize(process.env);
  const ledger = createRunHistoryStore(process.env);
  const usage = createUsageStore(process.env);

  const usageReport = await queryUsage(usage, {});
  if (!usageReport.ok) {
    console.error(`[ERROR] The usage ledger could not be read: ${usageReport.error ?? "unknown"}`);
    return 1;
  }

  const pairs: CalibrationPair[] = [];
  let runsWithoutEstimate = 0;
  for (const run of usageReport.report.byRun) {
    try {
      const pair = await pairForRun(run.runId, ledger, usage, args.period);
      if (pair) pairs.push(pair);
      else runsWithoutEstimate += 1;
    } catch (error) {
      console.error(
        `[WARN] Run ${run.runId} could not be read and was skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const report = buildCalibrationReport({ pairs, runsWithoutEstimate, minimumSampleSize });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log("Dark Factory — plan-estimate calibration (#490)");
  console.log(`period: ${args.period ?? "all"}`);
  console.log(`minimum sample: ${minimumSampleSize}`);
  console.log(
    `pairs: ${report.sampleSize} | runs without an estimate (excluded): ${report.excludedWithoutEstimate}`,
  );
  console.log("");

  if (!report.reportable) {
    console.log(`WITHHELD — ${report.reason}: ${report.sampleSize} < ${minimumSampleSize}`);
    console.log("The counts are real; the figures are not publishable yet.");
    return 0;
  }

  console.log(
    `signed bias (estimate - actual): ${money(report.bias.value)}  n=${report.bias.sampleSize}`,
  );
  console.log(`MAE: ${money(report.mae.value)}  n=${report.mae.sampleSize}`);
  console.log(`MAPE: ${percentage(report.mape.value)}  n=${report.mape.sampleSize}`);
  console.log(`calibration factor (actual / estimate): ${report.factor?.toFixed(4) ?? "withheld"}`);
  console.log("");

  console.log("by stage:");
  for (const stage of report.byStage) {
    console.log(
      `  ${stage.stage.padEnd(10)}${stage.measured ? " " : " (unmeasured)"} bias ${money(stage.bias.value).padStart(9)}` +
        `  mae ${money(stage.mae.value).padStart(9)}` +
        `  mape ${percentage(stage.mape.value).padStart(9)}  n=${stage.bias.sampleSize}`,
    );
  }
  console.log("");
  console.log("by cost class:");
  for (const group of report.byCostClass) {
    console.log(
      `  ${group.costClass.padEnd(10)} bias ${money(group.bias.value).padStart(9)}` +
        `  mae ${money(group.mae.value).padStart(9)}` +
        `  mape ${percentage(group.mape.value).padStart(9)}  n=${group.bias.sampleSize}`,
    );
  }
  console.log("");
  console.log(
    "note: a stage with no recorded usage is absent from 'actual'. The developer path does not " +
      "record usage on the in-process path yet, so its spend is unmeasured rather than zero.",
  );
  return 0;
}

const invokedDirectly = process.argv[1]?.includes("df-calibration-report");
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`[ERROR] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
