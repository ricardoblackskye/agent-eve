import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Runner environment bootstrap for the Dark Factory.
 *
 * Extracted from `scripts/dark-factory-runner.ts` so it can be tested without
 * importing a script that runs an end-to-end pipeline at module scope.
 *
 * Deliberately carries NO model default. `agent/model-config.ts` is the single
 * source of truth for which model is used, and a code default here silently
 * replaced it with a legacy model (issue #400). An unset `EVE_CHAT_MODEL` now
 * falls through to `DEFAULT_MODEL_ID` at the resolver.
 *
 * The same rule is why `DF_WORKER_ALLOWED_REPOS` is absent: defaulting it made
 * an unconfigured deployment look authorized (#348).
 */

export interface InitRunnerEnvOptions {
  /** Directory holding the `.env` file. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The env object to populate. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export function initRunnerEnv(
  opts?: InitRunnerEnvOptions,
): Record<string, string | undefined> {
  const env = opts?.env ?? process.env;
  const envPath = join(opts?.cwd ?? process.cwd(), ".env");

  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        env[key] = val;
      }
    }
  }

  return env;
}
