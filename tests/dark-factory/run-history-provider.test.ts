import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConsoleRunHistoryStore,
  createRunHistoryStore,
  RunHistoryConfigurationError,
} from "../../agent/lib/dark-factory/run-history-provider";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("configured run-history provider", () => {
  it("defaults to refusal rather than an in-memory store", async () => {
    const store = createRunHistoryStore({});
    expect(store).toBeInstanceOf(ConsoleRunHistoryStore);
    expect(store.id).toBe("console");
    const write = await store.acceptDelivery({
      deliveryId: "delivery-1",
      repo: "owner/repo",
      issue: 198,
      receivedAt: "2026-09-24T12:00:00.000Z",
    });
    expect(write.ok).toBe(false);
    expect(write.mode).toBe("blocked");
    expect(write.error).toMatch(/not configured/i);
    const control = await store.claimControlDelivery({
      deliveryId: "control-delivery-1",
      repo: "owner/repo",
      issue: 198,
      transition: "abort",
      receivedAt: "2026-09-24T12:00:00.000Z",
    });
    expect(control.ok).toBe(false);
    expect(control.error).toMatch(/not configured/i);
    const progress = await store.advanceControlDelivery({
      deliveryId: "control-delivery-1",
      repo: "owner/repo",
      issue: 198,
      transition: "abort",
      receivedAt: "2026-09-24T12:00:00.000Z",
      completed: true,
    });
    expect(progress.ok).toBe(false);
    expect(progress.error).toMatch(/not configured/i);
    const metrics = await store.getRunMetrics({ repo: "owner/repo" });
    expect(metrics.ok).toBe(false);
    expect(metrics.mode).toBe("blocked");
    expect(metrics.value).toBeNull();
    expect(metrics.error).toMatch(/not configured/i);
  });

  it("rejects an unknown driver and missing SQLite path", () => {
    expect(() =>
      createRunHistoryStore({ DF_RUN_HISTORY_DRIVER: "memory" }),
    ).toThrow(RunHistoryConfigurationError);
    expect(() =>
      createRunHistoryStore({ DF_RUN_HISTORY_DRIVER: "sqlite" }),
    ).toThrow(/DF_RUN_HISTORY_DB_PATH/);
  });

  it("refuses ephemeral SQLite storage in deployed environments", () => {
    const cases = [
      { NODE_ENV: "production" },
      { DF_PLATFORM_PROVIDER: "generic", DF_DEPLOYMENT_ENV: "preview" },
      { DF_PLATFORM_PROVIDER: "generic", DF_DEPLOYMENT_ENV: "production" },
      { DF_PLATFORM_PROVIDER: "vercel", VERCEL_ENV: "preview" },
    ];
    for (const environment of cases) {
      expect(() =>
        createRunHistoryStore({
          DF_RUN_HISTORY_DRIVER: "sqlite",
          DF_RUN_HISTORY_DB_PATH: "/tmp/runs.sqlite",
          ...environment,
        }),
      ).toThrow(/SQLite.*local|local.*SQLite/i);
    }
  });

  it("selects the explicit SQLite file adapter", () => {
    const directory = mkdtempSync(join(tmpdir(), "df-run-history-provider-"));
    directories.push(directory);
    const store = createRunHistoryStore({
      DF_RUN_HISTORY_DRIVER: "sqlite",
      DF_RUN_HISTORY_DB_PATH: join(directory, "runs.sqlite"),
    });
    expect(store.id).toBe("sqlite");
    store.close();
  });

  it("requires a PostgreSQL URL and selects the generic Postgres adapter lazily", async () => {
    expect(() =>
      createRunHistoryStore({ DF_RUN_HISTORY_DRIVER: "postgres" }),
    ).toThrow(/DF_RUN_HISTORY_DATABASE_URL/);
    const store = createRunHistoryStore({
      DF_RUN_HISTORY_DRIVER: "postgres",
      DF_RUN_HISTORY_DATABASE_URL: "postgres://user:pass@localhost:5432/runs",
    });
    expect(store.id).toBe("postgres");
    await store.close();
  });
});
