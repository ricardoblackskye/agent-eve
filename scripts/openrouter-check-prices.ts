/**
 * Dark Factory - check the shipped price ceilings against the LIVE provider catalog.
 *
 *   npm run prices:check              verify, and report drift
 *   npm run prices:check -- --write   also refresh the receipt
 *
 * This is deliberately NOT part of the default unit suite. The ceilings are our
 * constants; the dearest provider rate is somebody else's. Asserting the two against
 * each other inside the unit suite made every provider price rise a red build on PRs
 * that do not touch pricing (#494) - the rate moved three times in one day.
 *
 * So the live comparison lives here, is driven by the scheduled drift workflow, and
 * opening an issue is the response to drift. The unit suite asserts the hermetic half:
 * that the shipped ceiling still covers the receipt.
 *
 * It refuses to write a receipt it could not fully substantiate - the catalog unreadable,
 * a declared model missing, or a ceiling below the dearest observed rate all exit 1 with
 * nothing written. A receipt written under those conditions is theatre.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as modelConfig from "../agent/model-config";
import { modelPriceTable } from "../agent/lib/dark-factory/cost-budget";
import {
  buildPriceReceipt,
  ceilingsBelowObserved,
  type PriceObservation,
} from "../tests/support/openrouter-price-receipt";
import { loadLocalEnv } from "./load-env";

const RECEIPT_PATH = resolve(
  process.cwd(),
  "tests/support/openrouter-price-receipt.json",
);

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
): Promise<{ kind: "ok"; observation: PriceObservation } | { kind: "error"; reason: string }> {
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
    const rates: Array<{ input: number; output: number }> = [];
    for (const endpoint of endpoints) {
      const prompt = Number(endpoint.pricing?.prompt);
      const completion = Number(endpoint.pricing?.completion);
      if (Number.isFinite(prompt) && Number.isFinite(completion)) {
        rates.push({ input: prompt * 1000, output: completion * 1000 });
      }
    }
    if (rates.length === 0) {
      return { kind: "error", reason: "no priced endpoints returned" };
    }
    return {
      kind: "ok",
      observation: {
        inputUsdPer1k: Math.max(...rates.map((r) => r.input)),
        outputUsdPer1k: Math.max(...rates.map((r) => r.output)),
        providers: rates.length,
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

  const write = process.argv.includes("--write");
  const declared = declaredModelIds();
  if (declared.length === 0) {
    console.error("No model ids are declared in agent/model-config.ts.");
    process.exitCode = 1;
    return;
  }

  const observed: Record<string, PriceObservation> = {};
  for (const id of declared) {
    const result = await fetchDearestRate(id);
    if (result.kind === "error") {
      console.error(`Cannot verify ${id}: ${result.reason}`);
      console.error(
        "Nothing was written - a receipt may only record rates that were seen.",
      );
      process.exitCode = 1;
      return;
    }
    observed[id] = result.observation;
  }

  const receipt = buildPriceReceipt(
    observed,
    "https://openrouter.ai/api/v1/models/<id>/endpoints",
    new Date(),
  );

  console.log("Dearest provider rate per declared model (USD per 1k):");
  for (const [id, rate] of Object.entries(observed)) {
    const shipped = modelPriceTable[id];
    console.log(
      `  ${id}: observed in=${rate.inputUsdPer1k} out=${rate.outputUsdPer1k} ` +
        `(${rate.providers} providers) | shipped in=${shipped?.inputUsdPer1k} out=${shipped?.outputUsdPer1k}`,
    );
  }

  const problems = ceilingsBelowObserved(modelPriceTable, receipt);
  if (problems.length > 0) {
    console.error(`\nDRIFT: ${problems.length} shipped ceiling(s) no longer cover the dearest provider rate:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "\nRaise the ceiling in agent/lib/dark-factory/cost-budget.ts, then re-run with --write.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\nAll shipped ceilings cover the dearest provider rate.");

  if (!write) {
    console.log("Receipt not written (pass --write to refresh it).");
    return;
  }
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`Wrote ${RECEIPT_PATH} (verifiedAt ${receipt.verifiedAt}).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
