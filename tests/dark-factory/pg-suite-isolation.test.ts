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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
    expect(() => testDsnFor("host=localhost port=5432", "x")).toThrow(/URL|understood/i);
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

/**
 * #392 task 7 — a GUARD, not a RED: it passes today and exists so the flake can never be "fixed" by making the
 * suite slow. Serializing everything would hide the interference instead of removing it, and the sqlite suites —
 * the large majority — would pay for it on every run.
 */
describe("#392 the fix must not cost the fast path", () => {
  it("keeps file parallelism on, and serializes no suite", async () => {
    const mod = await import("../../vitest.config");
    const config = (mod.default ?? mod) as { test?: Record<string, unknown> };
    const test = config.test ?? {};

    expect(test.fileParallelism).not.toBe(false);
    expect(test.maxWorkers).not.toBe(1);
    expect(test.singleThread).not.toBe(true);
    // No per-file serialization of the Postgres suites: the isolation, not a queue, is what removes the race.
    expect(JSON.stringify(test.sequence ?? {})).not.toMatch(/active-run-claim|retire-run-claim|pg/i);
    expect(JSON.stringify(test.exclude ?? [])).not.toMatch(/active-run-claim|retire-run-claim/);
  });
});

/**
 * #409 — every Postgres suite must be registered, and each must declare exactly ONE database variable: its own.
 *
 * The suite this guard exists for gated on `DF_CONTROL_DATABASE_URL`, a production-shaped name, while the global
 * setup prepared the control tables for `DF_CONTROL_TEST_DATABASE_URL`. It therefore skipped in every local run
 * (0.5pp of coverage difference, one file, invisible for weeks) and would have run against a LIVE database had that
 * production name been set. The list of suites is DISCOVERED by scanning, so a new suite cannot be forgotten.
 */
describe("#409 every pg suite declares its own variable", () => {
  const DSN_REF = /process\.env\.(DF_[A-Z0-9_]*DATABASE_URL)/g;
  const SELF = "pg-suite-isolation.test.ts";

  function pgSuiteFiles(): { file: string; vars: string[] }[] {
    const dir = join(process.cwd(), "tests", "dark-factory");
    return readdirSync(dir)
      .filter((name) => name.endsWith(".test.ts") && name !== SELF)
      .map((file) => {
        const source = readFileSync(join(dir, file), "utf8");
        return { file, vars: [...new Set([...source.matchAll(DSN_REF)].map((m) => m[1]))] };
      })
      .filter((entry) => entry.vars.length > 0);
  }

  it("finds the Postgres suites by scanning, so a new one cannot be forgotten", () => {
    const files = pgSuiteFiles().map((entry) => entry.file);
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files).toContain("control-postgres.test.ts");
  });

  it("registers every suite file, and each declares only its own variable", () => {
    for (const { file, vars } of pgSuiteFiles()) {
      const entry = PG_SUITES.find((suite) => suite.file === file);
      expect(entry, `${file} must be registered in PG_SUITES`).toBeDefined();
      expect(vars, `${file} must read exactly one database variable: its own`).toEqual([entry!.dsnVar]);
    }
  });

  it("gives the control suite its own schema, like its six siblings", () => {
    const control = PG_SUITES.find((suite) => suite.file === "control-postgres.test.ts");
    expect(control, "the control suite must be registered").toBeDefined();
    expect(control!.dsnVar).toBe("DF_CONTROL_TEST_DATABASE_URL");
    expect(new URL(testDsnFor(BASE, "control")).searchParams.get("options")).toBe(
      "-c search_path=df_test_control",
    );
  });
});
