import { describe, expect, it } from "vitest";
import {
  ConsoleControlProvider,
  ControlConfigurationError,
  SqliteControlAdapter,
  createControlStore,
} from "../../agent/lib/dark-factory/control";
import { PostgresControlAdapter } from "../../agent/lib/dark-factory/control-postgres";

describe("createControlStore", () => {
  it("defaults to the fail-closed console store", () => {
    expect(createControlStore({})).toBeInstanceOf(ConsoleControlProvider);
  });

  it("creates SQLite locally and refuses it in deployed environments", () => {
    expect(createControlStore({ DF_CONTROL_DRIVER: "sqlite", DF_CONTROL_DB_PATH: ":memory:" })).toBeInstanceOf(SqliteControlAdapter);
    expect(() => createControlStore({ NODE_ENV: "production", DF_CONTROL_DRIVER: "sqlite", DF_CONTROL_DB_PATH: ":memory:" })).toThrow(ControlConfigurationError);
  });

  it("creates Postgres with the dedicated URL or run-history fallback", () => {
    expect(createControlStore({ DF_CONTROL_DRIVER: "postgres", DF_CONTROL_DATABASE_URL: "postgresql://example" })).toBeInstanceOf(PostgresControlAdapter);
    expect(createControlStore({ DF_CONTROL_DRIVER: "postgres", DF_RUN_HISTORY_DATABASE_URL: "postgres://example" })).toBeInstanceOf(PostgresControlAdapter);
    expect(() => createControlStore({ DF_CONTROL_DRIVER: "postgres" })).toThrow(ControlConfigurationError);
  });

  it("rejects unknown drivers", () => {
    expect(() => createControlStore({ DF_CONTROL_DRIVER: "memory" })).toThrow(ControlConfigurationError);
  });
});
