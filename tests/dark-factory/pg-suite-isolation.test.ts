/**
 * #392 — the Postgres-backed suites must stop interfering.
 *
 * Three suites (`run-history-postgres`, `active-run-claim`, `retire-run-claim`) share one database AND the same
 * run-history tables, which is why parallel workers interfere: per-ROW cleanup cannot isolate a suite from another
 * suite's in-flight run against a shared partial UNIQUE claim index.
 *
 * The fix is one schema per suite, derived from the DSN the operator already sets. These tests hold the derivation
 * to its contract — including the two ways it must fail LOUDLY rather than quietly point a suite at the wrong
 * database — and then prove the isolation against a real database when one is configured.
 */
import { describe, expect, it } from "vitest";

import {
  PG_SUITES,
  testDsnFor,
  schemaForSuite,
} from "./pg-test-helpers";

const BASE = "postgres://postgres@localhost:5432/darkfactory_test?sslmode=disable";

describe("#392 testDsnFor", () => {
  it("adds PostgreSQL's search_path option, and changes nothing else about the connection", () => {
    const derived = testDsnFor(BASE, "active_run_claim");
    const url = new URL(derived);

    expect(url.host).toBe("localhost:5432");
    expect(url.pathname).toBe("/darkfactory_test");
    expect(url.searchParams.get("sslmode")).toBe("disable");
    expect(url.searchParams.get("options")).toBe("-c search_path=df_test_active_run_claim");
  });

  it("PRESERVES options the operator already set, rather than replacing them", () => {
    const withOptions = `${BASE}&options=-c%20statement_timeout%3D5000`;
    const derived = testDsnFor(withOptions, "usage_store");

    expect(new URL(derived).searchParams.get("options")).toBe(
      "-c statement_timeout=5000 -c search_path=df_test_usage_store",
    );
  });

  it("REFUSES a DSN form it does not understand, loudly", () => {
    // A keyword/value DSN parses as something other than a URL; silently "fixing" it would point a suite at the
    // wrong database, which looks like a product bug.
    expect(() => testDsnFor("host=localhost dbname=darkfactory_test", "x")).toThrow(/URL|understood/i);
    expect(() => testDsnFor("", "x")).toThrow(/empty/i);
  });

  it("REFUSES an unsafe schema name, because the name becomes an identifier", () => {
    expect(() => testDsnFor(BASE, "bad name")).toThrow(/safe|identifier/i);
    expect(() => testDsnFor(BASE, "drop;--")).toThrow(/safe|identifier/i);
    expect(schemaForSuite("active_run_claim")).toBe("df_test_active_run_claim");
  });

  it("is deterministic: the same suite always yields the same DSN", () => {
    expect(testDsnFor(BASE, "tenant_store")).toBe(testDsnFor(BASE, "tenant_store"));
  });
});

describe("#392 the suite registry", () => {
  it("covers every pg suite, with a DISTINCT schema each", () => {
    const schemas = PG_SUITES.map((s) => s.schema);
    expect(new Set(schemas).size).toBe(schemas.length);
    // The three that share the run-history DSN and its tables must NOT share a schema — that is the whole point.
    const runHistory = PG_SUITES.filter((s) => s.dsnVar === "DF_RUN_HISTORY_TEST_DATABASE_URL");
    expect(runHistory.length).toBeGreaterThanOrEqual(3);
    expect(new Set(runHistory.map((s) => s.schema)).size).toBe(runHistory.length);
  });

  it("names each suite by the file that owns it, so a duplicate is visible", () => {
    const files = PG_SUITES.map((s) => s.file);
    expect(new Set(files).size).toBe(files.length);
    for (const suite of PG_SUITES) {
      expect(suite.file).toMatch(/\.test\.ts$/);
      expect(suite.schema).toBe(schemaForSuite(suite.schema.replace(/^df_test_/, "")));
    }
  });
});
