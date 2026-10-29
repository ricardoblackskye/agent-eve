/**
 * Dark Factory - check the shipped price ceilings against the LIVE provider catalog.
 *
 *   npm run prices:check              verify, and report drift
 *   npm run prices:check -- --write   also refresh the shipped observation
 *
 * This is deliberately NOT part of the default unit suite. The ceilings are our constants; the
 * dearest provider rate is somebody else's. Asserting the two against each other inside the unit
 * suite made every provider price rise a red build on PRs that do not touch pricing (#494) - the
 * rate moved six times in one day.
 *
 * So the live comparison lives here, is driven by the scheduled drift workflow, and opening an issue
 * is the response to drift. The unit suite asserts the hermetic half against the SAME data this
 * script writes: the GENERATED `agent/lib/dark-factory/model-price-floor-data.ts`, which the
 * shipped floor module reads. The path comes from PRICE_FLOOR_DATA_RELATIVE_PATH so the writer
 * and the reader cannot drift apart, and the file is generated wholesale so there is no hand-written
 * region to parse.
 *
 * It refuses to write an observation it could not fully substantiate - the catalog unreadable, a
 * declared model missing, or a ceiling below the dearest observed rate all exit 1 with nothing
 * written. A record written under those conditions is theatre: the guard would then certify a
 * reading nobody took.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as modelConfig from "../agent/model-config";
import { modelPriceTable } from "../agent/lib/dark-factory/cost-budget";
import {
  PRICE_FLOOR_DATA_RELATIVE_PATH,
  PRICE_FLOOR_SOURCE,
  PRICE_OUTLIER_MULTIPLE,
  capRate,
  buildPriceFloorRecord,
  ceilingsBelowObserved,
  renderPriceFloorModule,
  stalenessNotice,
  type DearestObservation,
} from "../agent/lib/dark-factory/model-price-floor";
import { loadLocalEnv } from "./load-env";

const FLOOR_PATH = resolve(process.cwd(), PRICE_FLOOR_DATA_RELATIVE_PATH);

const MODEL_ENDPOINTS_URL = (id: string): string =>
  `https://openrouter.ai/api/v1/models/${id}/endpoints`;

function declaredModelIds(): string[] {
  return Object.entries(modelConfig)
    .filter(
      ([name, value]) => name.endsWith("_MODEL_ID") && typeof value === "string",
    )
    .map(([, value]) => value as string);
}

/** Dearest prompt/completion rate across every provider fronting the model. */
async function fetchDearestRate(
  id: string,
): Promise<{ kind: "ok"; observation: DearestObservation } | { kind: "error"; reason: string }> {
  try {
    const response = await fetch(MODEL_ENDPOINTS_URL(id), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return { kind: "error", reason: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as {
      data?: { endpoints?: Array<{ pricing?: { prompt?: string; completion?: string } }> };
    };
    const endpoints = body.data?.endpoints ?? [];
    const inputs: number[] = [];
    const outputs: number[] = [];
    for (const endpoint of endpoints) {
      const prompt = Number(endpoint.pricing?.prompt);
      const completion = Number(endpoint.pricing?.completion);
      if (Number.isFinite(prompt) && Number.isFinite(completion)) {
        inputs.push(prompt * 1000);
        outputs.push(completion * 1000);
      }
    }
    if (inputs.length === 0) {
      return { kind: "error", reason: "no priced endpoints returned" };
    }

    // #499: the rates are KEPT, not reduced to a maximum. That is what lets the distribution be reported, and
    // what stops one provider setting the reservation an order of magnitude above its peers.
    const input = capRate(inputs);
    const output = capRate(outputs);
    const declinedInput = input.cappedFromUsdPer1k;
    const declinedOutput = output.cappedFromUsdPer1k;
    return {
      kind: "ok",
      observation: {
        inputUsdPer1k: input.adoptedUsdPer1k,
        outputUsdPer1k: output.adoptedUsdPer1k,
        providers: inputs.length,
        ...(input.distribution && output.distribution
          ? { distribution: { input: input.distribution, output: output.distribution } }
          : {}),
        ...(declinedInput !== undefined || declinedOutput !== undefined
          ? {
              declinedDearestUsdPer1k: {
                ...(declinedInput !== undefined ? { input: declinedInput } : {}),
                ...(declinedOutput !== undefined ? { output: declinedOutput } : {}),
              },
            }
          : {}),
      },
    };
  } catch (error) {
    return {
      kind: "error",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  loadLocalEnv();

  // Surfaced before anything else: staleness needs no network and must be visible even when the
  // drift check below fails the run.
  const staleness = stalenessNotice(new Date());
  if (staleness) console.warn(staleness);

  const write = process.argv.includes("--write");
  const declared = declaredModelIds();
  if (declared.length === 0) {
    console.error("No model ids are declared in agent/model-config.ts.");
    process.exitCode = 1;
    return;
  }

  const observed: Record<string, DearestObservation> = {};
  for (const id of declared) {
    const result = await fetchDearestRate(id);
    if (result.kind === "error") {
      console.error(`Cannot verify ${id}: ${result.reason}`);
      console.error(
        "Nothing was written - a record may only hold rates that were seen.",
      );
      process.exitCode = 1;
      return;
    }
    observed[id] = result.observation;
  }

  const record = buildPriceFloorRecord(observed, PRICE_FLOOR_SOURCE, new Date());

  console.log("Adopted provider rate per declared model (USD per 1k):");
  for (const [id, rate] of Object.entries(observed)) {
    const shipped = modelPriceTable[id];
    console.log(
      `  ${id}: adopted in=${rate.inputUsdPer1k} out=${rate.outputUsdPer1k} ` +
        `(${rate.providers} providers) | shipped in=${shipped?.inputUsdPer1k} out=${shipped?.outputUsdPer1k}`,
    );
    const distribution = rate.distribution;
    if (distribution) {
      const out = distribution.output;
      console.log(
        `    distribution (output): median ${out.median} | p90 ${out.p90} | second-dearest ` +
          `${out.secondDearest} | cap ${PRICE_OUTLIER_MULTIPLE} x p90 = ${PRICE_OUTLIER_MULTIPLE * out.p90}`,
      );
    }
    const declined = rate.declinedDearestUsdPer1k;
    if (declined) {
      console.log(
        `    OUTLIER declined, not adopted: in=${declined.input ?? "n/a"} out=${declined.output ?? "n/a"}` +
          " (a provider this far above its peers is reported rather than reserved against - #499)",
      );
    }
  }

  const problems = ceilingsBelowObserved(modelPriceTable, record);
  if (problems.length > 0) {
    console.error(
      `\nDRIFT: ${problems.length} shipped ceiling(s) no longer cover the dearest provider rate:`,
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nRaise the ceiling in agent/lib/dark-factory/cost-budget.ts, then re-run with --write.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nAll shipped ceilings cover the dearest provider rate.");

  if (!write) {
    console.log("Observation not written (pass --write to refresh it).");
    return;
  }
  writeFileSync(FLOOR_PATH, renderPriceFloorModule(record), "utf8");
  console.log(`Wrote ${PRICE_FLOOR_DATA_RELATIVE_PATH} (verifiedAt ${record.verifiedAt}).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
