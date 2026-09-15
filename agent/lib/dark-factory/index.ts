/**
 * Dark Factory — R1 wiring (issues #134, #138, #140).
 *
 * Single place where the seam adapters are chosen from the environment, so the
 * orchestrator never imports a concrete adapter directly. Every factory is
 * fail-closed: an unset driver yields the refusing default rather than a
 * silently non-persistent in-process store.
 */

import { ConsoleStateProvider, SqliteStateAdapter, type StateStore } from "./state";

/**
 * Choose the execution-memory store from the environment.
 *
 * `DF_STATE_DRIVER` unset/empty -> fail-closed `console` provider (refuses every
 * write rather than pretending to persist). `sqlite` -> the file-backed adapter,
 * which requires `DF_STATE_DB_PATH`. Anything else is a configuration error and
 * throws rather than silently degrading to a store that loses state.
 */
export function createStateStore(
  env: Record<string, string | undefined> = process.env,
): StateStore {
  const driver = (env.DF_STATE_DRIVER || "").trim();
  if (driver === "") return new ConsoleStateProvider();

  if (driver === "sqlite") {
    const dbPath = (env.DF_STATE_DB_PATH || "").trim();
    if (!dbPath) {
      throw new Error(
        "DF_STATE_DRIVER=sqlite requires DF_STATE_DB_PATH (filesystem path to the SQLite database).",
      );
    }
    return new SqliteStateAdapter(dbPath);
  }

  throw new Error(
    `Unknown DF_STATE_DRIVER '${driver}'. Supported drivers: sqlite (leave unset for the fail-closed console default).`,
  );
}