import { describe, expect, it } from "vitest";
import {
  TenantConfigurationError,
  createTenantStore,
  isTenantRegistryConfigured,
} from "../../agent/lib/dark-factory/tenant-store-provider";
import { InMemoryTenantStore } from "../../agent/lib/dark-factory/tenant-store";
import { SqliteTenantStore } from "../../agent/lib/dark-factory/tenant-store-sqlite";
import { PostgresTenantStore } from "../../agent/lib/dark-factory/tenant-store-postgres";

const PG = "postgresql://user:pw@host:5432/db?sslmode=no-verify";

describe("createTenantStore", () => {
  it("defaults to the in-memory store when no driver is set", () => {
    expect(createTenantStore({})).toBeInstanceOf(InMemoryTenantStore);
  });

  it("accepts an explicit memory driver", () => {
    expect(createTenantStore({ DF_TENANT_DRIVER: "memory" })).toBeInstanceOf(
      InMemoryTenantStore,
    );
  });

  it("is case- and whitespace-insensitive", () => {
    expect(createTenantStore({ DF_TENANT_DRIVER: "  POSTGRES ", DF_TENANT_DATABASE_URL: PG })).toBeInstanceOf(
      PostgresTenantStore,
    );
  });

  it("builds a Postgres store from a valid URL", () => {
    const store = createTenantStore({
      DF_TENANT_DRIVER: "postgres",
      DF_TENANT_DATABASE_URL: PG,
    });
    expect(store).toBeInstanceOf(PostgresTenantStore);
    store.close?.();
  });

  it("requires a connection string for Postgres", () => {
    expect(() => createTenantStore({ DF_TENANT_DRIVER: "postgres" })).toThrow(
      TenantConfigurationError,
    );
  });

  it("rejects a non-postgres URL", () => {
    expect(() =>
      createTenantStore({
        DF_TENANT_DRIVER: "postgres",
        DF_TENANT_DATABASE_URL: "mysql://user:pw@host:3306/db",
      }),
    ).toThrow(TenantConfigurationError);
  });

  it("builds a SQLite store from a path", () => {
    const store = createTenantStore({
      DF_TENANT_DRIVER: "sqlite",
      DF_TENANT_DB_PATH: "/tmp/tenants.sqlite",
    });
    expect(store).toBeInstanceOf(SqliteTenantStore);
    store.close?.();
  });

  it("requires a path for SQLite", () => {
    expect(() => createTenantStore({ DF_TENANT_DRIVER: "sqlite" })).toThrow(
      TenantConfigurationError,
    );
  });

  it("refuses SQLite when NODE_ENV is production", () => {
    expect(() =>
      createTenantStore({
        DF_TENANT_DRIVER: "sqlite",
        DF_TENANT_DB_PATH: "/tmp/tenants.sqlite",
        NODE_ENV: "production",
      }),
    ).toThrow(TenantConfigurationError);
  });

  it("refuses SQLite on a Vercel preview deployment", () => {
    expect(() =>
      createTenantStore({
        DF_TENANT_DRIVER: "sqlite",
        DF_TENANT_DB_PATH: "/tmp/tenants.sqlite",
        DF_PLATFORM_PROVIDER: "vercel",
        VERCEL_ENV: "preview",
      }),
    ).toThrow(TenantConfigurationError);
  });

  it("allows SQLite locally even when the platform provider is vercel", () => {
    const store = createTenantStore({
      DF_TENANT_DRIVER: "sqlite",
      DF_TENANT_DB_PATH: "/tmp/tenants.sqlite",
      DF_PLATFORM_PROVIDER: "vercel",
      VERCEL_ENV: "development",
    });
    expect(store).toBeInstanceOf(SqliteTenantStore);
    store.close?.();
  });

  it("throws on an unknown driver rather than degrading silently", () => {
    expect(() => createTenantStore({ DF_TENANT_DRIVER: "mysql" })).toThrow(
      TenantConfigurationError,
    );
  });

  it("names the supported drivers in the error", () => {
    expect(() => createTenantStore({ DF_TENANT_DRIVER: "mysql" })).toThrow(
      /postgres, sqlite/,
    );
  });
});

describe("isTenantRegistryConfigured", () => {
  it("is false when unset, so attribution is inert by default", () => {
    expect(isTenantRegistryConfigured({})).toBe(false);
  });

  it("is false for the memory driver", () => {
    expect(isTenantRegistryConfigured({ DF_TENANT_DRIVER: "memory" })).toBe(false);
  });

  it("is true for postgres and sqlite", () => {
    expect(isTenantRegistryConfigured({ DF_TENANT_DRIVER: "postgres" })).toBe(true);
    expect(isTenantRegistryConfigured({ DF_TENANT_DRIVER: "sqlite" })).toBe(true);
  });

  it("is false for an unknown driver", () => {
    expect(isTenantRegistryConfigured({ DF_TENANT_DRIVER: "mysql" })).toBe(false);
  });
});