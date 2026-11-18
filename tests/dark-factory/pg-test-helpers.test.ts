import { describe, expect, it } from "vitest";
import { assertDisposableDsn } from "./pg-test-helpers";

/**
 * #332 — the safety rail around destructive SQL, proven rather than asserted.
 *
 * `resetPgTables` issues TRUNCATE. It must refuse anything that is not a test database, so a DSN
 * pointed at a real one fails loudly instead of quietly emptying a table. This is deliberately
 * DB-free so it cannot race the parallel suites.
 *
 * #689 — what makes a database disposable is its NAME, not its host. The old rule accepted any
 * localhost DSN, and the local run launcher writes its live ledger to
 * `postgres://postgres@localhost:5432/darkfactory` (see df232-run.sh), so the pre-push gate
 * truncated the rows a real run had just recorded. Every localhost case below is therefore a
 * refusal — and the acceptance cases are here so this cannot pass by refusing everything.
 */
describe("#332 reset safety rail", () => {
  it("refuses a DSN that does not look like a test database", () => {
    expect(() => assertDisposableDsn("postgresql://user@db.example.com:5432/production")).toThrow(
      /does not look like a disposable test database/,
    );
  });

  it("refuses the DSN the local run launcher writes its live ledger to", () => {
    // #689: this exact DSN is in the local run launcher. It is a live ledger, not a test database,
    // and the reset accepted it purely because the host was localhost.
    expect(() =>
      assertDisposableDsn("postgres://postgres@localhost:5432/darkfactory?sslmode=disable"),
    ).toThrow(/does not look like a disposable test database/);
  });

  it("refuses a LOCALHOST DSN whose database is not a test database", () => {
    // The host carries no information: a remote CI service container is disposable and a local
    // ledger is not. Only the database name does.
    expect(() => assertDisposableDsn("postgresql://df_test@127.0.0.1:55432/df_run_history")).toThrow(
      /does not look like a disposable test database/,
    );
  });

  it("refuses a DSN it cannot parse, rather than crashing", () => {
    // Fail closed: a keyword/value DSN has no URL path to read a database name from.
    expect(() => assertDisposableDsn("host=localhost port=5432")).toThrow(
      /does not look like a disposable test database/,
    );
    expect(() => assertDisposableDsn("")).toThrow(/does not look like a disposable test database/);
  });

  it("accepts the test databases the suites actually use, whatever the host", () => {
    expect(() =>
      assertDisposableDsn("postgres://postgres@localhost:5432/darkfactory_test?sslmode=disable"),
    ).not.toThrow();
    expect(() =>
      assertDisposableDsn("postgresql://df_test@127.0.0.1:55432/df_run_history_test"),
    ).not.toThrow();
    // A remote host is fine: the database is disposable because of its name, not its address.
    expect(() => assertDisposableDsn("postgresql://u@db.example.com:5432/df_usage_test")).not.toThrow();
  });
});
