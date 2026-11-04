import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../scripts/db-migrate";

/**
 * #593 Task 2/3/4/5 — integration against a disposable PostgreSQL database.
 *
 * Opt-in: set `DF_MIGRATE_TEST_DATABASE_URL` to a database dedicated to this suite. Without it the suite
 * skips, so `npm test` stays hermetic. The suite refuses to run against a database that already has
 * tables, so a misconfigured DSN cannot truncate a real environment.
 *
 * Covers what the unit tests cannot: transactions, the advisory lock, and whether a recorded row really
 * means the migration ran.
 */
const DSN = process.env.DF_MIGRATE_TEST_DATABASE_URL ?? "";
const suite = DSN ? describe : describe.skip;

const dirs: string[] = [];
let client: Client;

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "migrate-int-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

async function tableExists(name: string): Promise<boolean> {
  const result = await client.query(
    "select 1 from information_schema.tables where table_schema = 'public' and table_name = $1",
    [name],
  );
  return result.rowCount === 1;
}

async function recordedVersions(): Promise<string[]> {
  const result = await client.query<{ version: string }>(
    "select version from schema_migrations order by version",
  );
  return result.rows.map((row) => row.version);
}

suite("db-migrate integration (#593)", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: DSN });
    await client.connect();

    // Safety: refuse a database that already has tables. The suite creates and drops its own fixtures;
    // if it starts against a populated database the cleanup step would destroy someone's data.
    const existing = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    if (existing.rowCount !== 0) {
      throw new Error(
        `DF_MIGRATE_TEST_DATABASE_URL points at a database with ${existing.rowCount} existing table(s); use a disposable database`,
      );
    }
  }, 30_000);

  afterAll(async () => {
    await client.end();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Leave the database empty for the next test, and prove the suite cleans up after itself.
    await client.query("drop table if exists schema_migrations cascade");
    await client.query("drop table if exists widgets cascade");
    await client.query("drop table if exists gadgets cascade");
    await client.query("drop table if exists broken cascade");
  });

  it("applies pending migrations in order and records them", async () => {
    const dir = fixture({
      "001_widgets.sql": "create table widgets (id integer primary key);",
      "002_gadgets.sql": "create table gadgets (id integer primary key);",
    });

    const result = await runMigrations(client, { dir, action: "apply" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.applied).toEqual(["001_widgets.sql", "002_gadgets.sql"]);

    expect(await recordedVersions()).toEqual(["001_widgets.sql", "002_gadgets.sql"]);
    expect(await tableExists("widgets")).toBe(true);
    expect(await tableExists("gadgets")).toBe(true);
  }, 30_000);

  it("is idempotent — a second apply records nothing new", async () => {
    const dir = fixture({
      "001_widgets.sql": "create table widgets (id integer primary key);",
    });

    expect((await runMigrations(client, { dir, action: "apply" })).ok).toBe(true);
    const second = await runMigrations(client, { dir, action: "apply" });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.applied).toEqual([]);
    expect(await recordedVersions()).toEqual(["001_widgets.sql"]);
  }, 30_000);

  it("status changes nothing", async () => {
    const dir = fixture({
      "001_widgets.sql": "create table widgets (id integer primary key);",
    });

    const result = await runMigrations(client, { dir, action: "status" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pending).toEqual(["001_widgets.sql"]);

    expect(await tableExists("widgets")).toBe(false);
    expect(await tableExists("schema_migrations")).toBe(false);
  }, 30_000);

  it("refuses when an applied file's checksum changed", async () => {
    const dir = fixture({
      "001_widgets.sql": "create table widgets (id integer primary key);",
    });
    expect((await runMigrations(client, { dir, action: "apply" })).ok).toBe(true);

    // Edit the file AFTER it was applied — the silent-skip failure this tool exists to prevent.
    writeFileSync(
      join(dir, "001_widgets.sql"),
      "create table widgets (id integer primary key, name text);",
    );

    const result = await runMigrations(client, { dir, action: "apply" });
    expect(result.ok).toBe(false);
    expect(result.drift?.[0]?.kind).toBe("checksum-mismatch");
  }, 30_000);

  it("refuses when the database is ahead of the checkout", async () => {
    const dir = fixture({
      "001_widgets.sql": "create table widgets (id integer primary key);",
    });
    expect((await runMigrations(client, { dir, action: "apply" })).ok).toBe(true);

    await client.query(
      "insert into schema_migrations (version, checksum) values ($1, $2)",
      ["099_missing.sql", "deadbeef"],
    );

    const result = await runMigrations(client, { dir, action: "apply" });
    expect(result.ok).toBe(false);
    expect(result.drift?.[0]?.kind).toBe("missing-from-disk");
  }, 30_000);

  it("rolls back a failing migration and does not record it", async () => {
    const dir = fixture({
      "001_widgets.sql": "create table widgets (id integer primary key);",
      "002_broken.sql": "create table broken (id integer primary key); this is not valid sql;",
    });

    const result = await runMigrations(client, { dir, action: "apply" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failed).toBe("002_broken.sql");

    // 001 committed and recorded; 002 rolled back and NOT recorded; its table must not exist.
    expect(await recordedVersions()).toEqual(["001_widgets.sql"]);
    expect(await tableExists("broken")).toBe(false);
  }, 30_000);

  it("serializes two concurrent applies with an advisory lock", async () => {
    const dir = fixture({
      "001_widgets.sql": "create table widgets (id integer primary key);",
      "002_gadgets.sql": "create table gadgets (id integer primary key);",
    });

    const other = new Client({ connectionString: DSN });
    await other.connect();
    try {
      const [a, b] = await Promise.all([
        runMigrations(client, { dir, action: "apply" }),
        runMigrations(other, { dir, action: "apply" }),
      ]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);

      // Each version recorded exactly once, even though two runners raced.
      expect(await recordedVersions()).toEqual(["001_widgets.sql", "002_gadgets.sql"]);
      const count = await client.query<{ n: string }>(
        "select count(*) as n from schema_migrations",
      );
      expect(Number(count.rows[0].n)).toBe(2);
    } finally {
      await other.end();
    }
  }, 30_000);
});
