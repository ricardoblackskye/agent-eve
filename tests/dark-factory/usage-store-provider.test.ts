import { describe, expect, it } from "vitest";
import {
  createUsageStore,
  isUsageRecordingConfigured,
  UsageConfigurationError,
} from "../../agent/lib/dark-factory/usage-store-provider";

describe("createUsageStore", () => {
  it("defaults to the in-memory store with no external writes", () => {
    expect(createUsageStore({}).id).toBe("memory");
    expect(createUsageStore({ DF_USAGE_DRIVER: "" }).id).toBe("memory");
    expect(createUsageStore({ DF_USAGE_DRIVER: "memory" }).id).toBe("memory");
    expect(createUsageStore({ DF_USAGE_DRIVER: "  MEMORY  " }).id).toBe("memory");
  });

  it("refuses sqlite in a deployed runtime, because it is local-only", () => {
    expect(() =>
      createUsageStore({
        DF_USAGE_DRIVER: "sqlite",
        DF_USAGE_DB_PATH: "/tmp/usage.sqlite",
        NODE_ENV: "production",
      }),
    ).toThrow(UsageConfigurationError);

    expect(() =>
      createUsageStore({
        DF_USAGE_DRIVER: "sqlite",
        DF_USAGE_DB_PATH: "/tmp/usage.sqlite",
        DF_PLATFORM_PROVIDER: "vercel",
        VERCEL_ENV: "preview",
      }),
    ).toThrow(UsageConfigurationError);
  });

  it("requires DF_USAGE_DB_PATH for sqlite", () => {
    expect(() => createUsageStore({ DF_USAGE_DRIVER: "sqlite" })).toThrow(
      UsageConfigurationError,
    );
    expect(() =>
      createUsageStore({ DF_USAGE_DRIVER: "sqlite", DF_USAGE_DB_PATH: "   " }),
    ).toThrow(UsageConfigurationError);
  });

  it("builds a sqlite store locally when a path is given", () => {
    const store = createUsageStore({
      DF_USAGE_DRIVER: "sqlite",
      DF_USAGE_DB_PATH: "/tmp/df-usage-provider-test.sqlite",
    });
    expect(store.id).toBe("sqlite");
    store.close();
  });

  it("requires DF_USAGE_DATABASE_URL for postgres", () => {
    expect(() => createUsageStore({ DF_USAGE_DRIVER: "postgres" })).toThrow(
      UsageConfigurationError,
    );
  });

  it("rejects a non-postgres connection URL", () => {
    expect(() =>
      createUsageStore({
        DF_USAGE_DRIVER: "postgres",
        DF_USAGE_DATABASE_URL: "mysql://user@host/db",
      }),
    ).toThrow(UsageConfigurationError);
  });

  it("builds a postgres store without connecting eagerly", () => {
    const store = createUsageStore({
      DF_USAGE_DRIVER: "postgres",
      DF_USAGE_DATABASE_URL: "postgres://user@host:5432/db?sslmode=no-verify",
    });
    expect(store.id).toBe("postgres");
    // No connection is opened until a call is made; close() with no pool is safe.
    void store.close();
  });

  it("names the supported drivers for an unknown one", () => {
    expect(() => createUsageStore({ DF_USAGE_DRIVER: "nonsense" })).toThrow(
      /Supported drivers/,
    );
  });
});

describe("isUsageRecordingConfigured", () => {
  it("is false when nothing is configured, because recording is opt-in", () => {
    expect(isUsageRecordingConfigured({})).toBe(false);
    expect(isUsageRecordingConfigured({ DF_USAGE_DRIVER: "" })).toBe(false);
    expect(isUsageRecordingConfigured({ DF_USAGE_DRIVER: "memory" })).toBe(false);
  });

  it("is true only for an explicit external driver", () => {
    expect(isUsageRecordingConfigured({ DF_USAGE_DRIVER: "postgres" })).toBe(true);
    expect(isUsageRecordingConfigured({ DF_USAGE_DRIVER: "sqlite" })).toBe(true);
  });
});