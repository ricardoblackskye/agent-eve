import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checksumOf,
  computePlan,
  parseApplied,
  readMigrations,
  type MigrationFile,
} from "../../scripts/db-migrate";

/**
 * #593 Task 1 — pure plan computation. No database access: these functions decide WHAT to apply, and the
 * CLI refuses when the answer is "the database and the files disagree".
 *
 * The failure this suite exists for is silent: a migration edited after it was applied would otherwise be
 * skipped, leaving the database on a schema nobody reviewed. So checksum mismatches and "database ahead"
 * are refusals, not warnings.
 */
const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "migrate-test-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("checksumOf", () => {
  it("treats CRLF and LF as the same content", () => {
    // The same file checked out on Windows and Linux must hash the same, or a deploy reports false drift.
    expect(checksumOf("a\r\nb\r\n")).toBe(checksumOf("a\nb\n"));
  });

  it("changes when the content changes", () => {
    expect(checksumOf("a")).not.toBe(checksumOf("b"));
  });

  it("is a stable 64-character hex digest", () => {
    expect(checksumOf("select 1;")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("readMigrations", () => {
  it("sorts by filename so 002 follows 001 and 010 follows 002", () => {
    const dir = fixture({
      "010_j.sql": "select 10;",
      "002_b.sql": "select 2;",
      "001_a.sql": "select 1;",
    });
    expect(readMigrations(dir).map((migration) => migration.version)).toEqual([
      "001_a.sql",
      "002_b.sql",
      "010_j.sql",
    ]);
  });

  it("throws on a duplicate numeric prefix", () => {
    const dir = fixture({ "001_a.sql": "select 1;", "001_b.sql": "select 2;" });
    expect(() => readMigrations(dir)).toThrow(/duplicate/i);
  });

  it("throws on a filename that is not NNN_name.sql", () => {
    const dir = fixture({ "not-a-migration.sql": "select 1;" });
    expect(() => readMigrations(dir)).toThrow(/NNN/);
  });

  it("ignores files that are not .sql", () => {
    const dir = fixture({ "001_a.sql": "select 1;", "README.md": "notes" });
    expect(readMigrations(dir)).toHaveLength(1);
  });

  it("carries the raw SQL and a checksum for each file", () => {
    const dir = fixture({ "001_a.sql": "select 1;" });
    const [migration] = readMigrations(dir);
    expect(migration.sql).toBe("select 1;");
    expect(migration.checksum).toBe(checksumOf("select 1;"));
  });
});

describe("parseApplied", () => {
  it("maps version to checksum", () => {
    const applied = parseApplied([{ version: "001_a.sql", checksum: "abc" }]);
    expect(applied.get("001_a.sql")).toBe("abc");
  });

  it("treats an empty result as nothing applied", () => {
    expect(parseApplied([]).size).toBe(0);
  });
});

describe("computePlan", () => {
  const files: MigrationFile[] = [
    { version: "001_a.sql", checksum: "aaa", sql: "select 1;" },
    { version: "002_b.sql", checksum: "bbb", sql: "select 2;" },
  ];

  it("treats everything as pending when nothing is applied", () => {
    expect(computePlan(files, new Map())).toEqual({ ok: true, pending: files });
  });

  it("skips applied migrations whose checksum matches", () => {
    const plan = computePlan(files, new Map([["001_a.sql", "aaa"]]));
    expect(plan).toEqual({ ok: true, pending: [files[1]] });
  });

  it("reports nothing pending when everything is applied", () => {
    const plan = computePlan(
      files,
      new Map([
        ["001_a.sql", "aaa"],
        ["002_b.sql", "bbb"],
      ]),
    );
    expect(plan).toEqual({ ok: true, pending: [] });
  });

  it("refuses when an applied version is missing from disk (the database is ahead)", () => {
    const plan = computePlan(files, new Map([["001_a.sql", "aaa"], ["099_gone.sql", "zzz"]]));
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.drift).toEqual([{ kind: "missing-from-disk", version: "099_gone.sql" }]);
    }
  });

  it("refuses when an applied file's checksum changed", () => {
    const plan = computePlan(files, new Map([["001_a.sql", "different"]]));
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.drift).toEqual([
        { kind: "checksum-mismatch", version: "001_a.sql", expected: "aaa", actual: "different" },
      ]);
    }
  });

  it("reports every drift reason, not just the first", () => {
    const plan = computePlan(files, new Map([["001_a.sql", "x"], ["099_gone.sql", "z"]]));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.drift).toHaveLength(2);
  });
});
