import { describe, expect, it } from "vitest";
import { assertDisposableDsn } from "./pg-test-helpers";

/**
 * #332 — the safety rail around destructive SQL, proven rather than asserted.
 *
 * `resetPgTables` issues TRUNCATE. It must refuse anything that does not look disposable, so a DSN
 * pointed at a real database fails loudly instead of quietly emptying a table. This is deliberately
 * DB-free so it cannot race the parallel suites.
 */
describe("#332 reset safety rail", () => {
  it("refuses a DSN that does not look like a disposable test database", () => {
    expect(() => assertDisposableDsn("postgresql://user@db.example.com:5432/production")).toThrow(
      /does not look like a disposable test database/,
    );
  });

  it("accepts the test DSNs the suites actually use", () => {
    expect(() =>
      assertDisposableDsn("postgres://postgres@localhost:5432/darkfactory?sslmode=disable"),
    ).not.toThrow();
    expect(() =>
      assertDisposableDsn("postgresql://df_test@127.0.0.1:55432/df_run_history"),
    ).not.toThrow();
  });
});
