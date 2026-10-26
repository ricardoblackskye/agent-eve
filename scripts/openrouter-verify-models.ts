/**
 * Dark Factory - verify the declared model ids against the live provider and
 * write the verification receipt (#472, part 2).
 *
 *   npm run models:verify
 *
 * The receipt is what lets the default unit suite assert something real while
 * staying hermetic. It records ids that were ACTUALLY SEEN, so this command
 * refuses to write one it could not confirm:
 *
 *   - the catalog could not be read   -> refuse, exit 1, write nothing
 *   - a declared id is absent upstream -> refuse, exit 1, write nothing
 *
 * That refusal is the whole point. The moment this command writes a receipt for
 * an id it did not see, the guard becomes theatre and the offline test starts
 * certifying the thing it was written to check. It fails rather than warns.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as modelConfig from "../agent/model-config";
import {
  OPENROUTER_MODELS_URL,
  fetchCatalogIds,
} from "../tests/support/openrouter-catalog";
import { buildReceipt } from "../tests/support/openrouter-model-receipt";
import { loadLocalEnv } from "./load-env";

const RECEIPT_PATH = resolve(
  process.cwd(),
  "tests/support/openrouter-model-receipt.json",
);

/** Every model id the repo declares, whatever it is named. */
function declaredModelIds(): string[] {
  return Object.entries(modelConfig)
    .filter(
      ([name, value]) =>
        name.endsWith("_MODEL_ID") && typeof value === "string",
    )
    .map(([, value]) => value as string);
}

async function main(): Promise<void> {
  loadLocalEnv();

  const declared = declaredModelIds();
  if (declared.length === 0) {
    console.error(
      "No model ids are declared in agent/model-config.ts; nothing to verify.",
    );
    process.exitCode = 1;
    return;
  }

  const result = await fetchCatalogIds();

  if (result.kind === "unverifiable") {
    console.error(`Cannot read the live catalog: ${result.reason}`);
    console.error(
      "No receipt was written — a receipt may only record ids that were seen.",
    );
    process.exitCode = 1;
    return;
  }

  const missing = declared.filter((id) => !result.ids.has(id));
  if (missing.length > 0) {
    console.error(
      `Refusing to write a receipt: ${missing.length} declared id(s) are absent from the live catalog:`,
    );
    for (const id of missing) console.error(`  - ${id}`);
    process.exitCode = 1;
    return;
  }

  const receipt = buildReceipt(declared, OPENROUTER_MODELS_URL, new Date());
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  console.log(
    `Verified ${declared.length} declared id(s) against ${receipt.source}`,
  );
  for (const id of declared) console.log(`  - ${id}`);
  console.log(`Wrote ${RECEIPT_PATH} (verifiedAt ${receipt.verifiedAt}).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
