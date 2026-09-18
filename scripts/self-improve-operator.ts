#!/usr/bin/env node
/**
 * Operator CLI entry point (#159).
 *
 * A thin shim: it chooses the REAL state store from the environment, then hands
 * the argv to the pure command layer in `agent/lib/dark-factory/operator-cli.ts`.
 * All the behaviour (refusals, exit codes, expiry handling) lives there so it is
 * testable without spawning a process — this file only does I/O.
 *
 * Usage:  npm run operator -- list
 *         npm run operator -- allow <surfaceId> --by "Your Name" --expires +7d
 *         npm run operator -- clear <surfaceId>
 */

import process from "node:process";
import {
  createStateStore,
  resolveStateDbPath,
} from "../agent/lib/dark-factory/index";
import { createOperatorDecisionStore } from "../agent/lib/dark-factory/self-improve-state";
import { runOperatorCli } from "../agent/lib/dark-factory/operator-cli";

async function main(): Promise<void> {
  const store = createStateStore(process.env);
  const driver = (process.env.DF_STATE_DRIVER || "").trim();

  // Echo the target so the operator can see WHICH store they are arming — the
  // documented hazard being an ephemeral local file when production reads another.
  let target: string | null = null;
  if (driver === "sqlite") {
    target = resolveStateDbPath(
      (process.env.DF_STATE_DB_PATH || "").trim(),
      process.env.DF_STATE_DB_DIR,
    );
  }

  const result = await runOperatorCli(process.argv.slice(2), {
    storeId: store.id,
    target,
    decisions: createOperatorDecisionStore(store),
  });

  for (const line of result.lines) {
    console.log(line);
  }
  store.close?.();
  process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
  console.error(`operator: ${(error as Error).message}`);
  process.exitCode = 1;
});
