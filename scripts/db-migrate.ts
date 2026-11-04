import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

/**
 * #593 — apply `db/migrations/*.sql` to a hosted database.
 *
 * The pure functions below decide WHAT to apply and never touch a database; the CLI at the bottom is the
 * only part that connects. That split is what lets the plan-computation tests run with no Postgres.
 *
 * The invariant the whole tool exists for: a migration that was applied must not be silently skipped
 * when its file changes later. A checksum mismatch is a REFUSAL, not a warning.
 */

export interface MigrationFile {
  /** The filename, e.g. `001_df_cost_budgets.sql`. Used as the version key. */
  version: string;
  /** sha256 hex over the file with CRLF normalised to LF. */
  checksum: string;
  /** The raw SQL, read at plan time so the apply loop does not re-read a file that may have changed. */
  sql: string;
}

export type DriftReason =
  | { kind: "missing-from-disk"; version: string }
  | { kind: "checksum-mismatch"; version: string; expected: string; actual: string };

export type Plan =
  | { ok: true; pending: MigrationFile[] }
  | { ok: false; drift: DriftReason[] };

/** `NNN_name.sql` — three digits, underscore, lowercase name. Rejecting anything else keeps sort order meaningful. */
const FILENAME = /^(\d{3})_[a-z0-9_]+\.sql$/;

/**
 * sha256 of the file's text, with CRLF collapsed to LF first.
 *
 * Without the normalisation the same file hashes differently on a Windows checkout and a Linux deploy,
 * and every deploy reports false drift. This is the single most likely real-world failure of the tool.
 */
export function checksumOf(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

/**
 * Read every `.sql` migration in filename order. Non-SQL files are ignored; anything that does not match
 * `NNN_name.sql` throws, because a file the runner cannot name is a file it cannot safely order.
 */
export function readMigrations(dir: string): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const seen = new Map<string, string>();
  return names.map((version) => {
    const match = FILENAME.exec(version);
    if (!match) {
      throw new Error(`migration filename must match NNN_name.sql: ${version}`);
    }
    const prefix = match[1];
    const existing = seen.get(prefix);
    if (existing) {
      throw new Error(`duplicate migration prefix ${prefix}: ${existing} and ${version}`);
    }
    seen.set(prefix, version);
    const sql = readFileSync(join(dir, version), "utf8");
    return { version, checksum: checksumOf(sql), sql };
  });
}

/** Turn `schema_migrations` rows into a version → checksum map. */
export function parseApplied(
  rows: readonly { version: string; checksum: string }[],
): Map<string, string> {
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

/**
 * Decide what to apply, or refuse. Drift is reported in full — every reason, not just the first — so an
 * operator sees the whole disagreement in one run.
 *
 * Drift means either:
 * - a version recorded as applied has no file in this checkout (the database is AHEAD of the code), or
 * - a file's checksum no longer matches what was applied (the file changed AFTER it was applied).
 *
 * Both are refusals. Repairing either automatically would hide exactly the divergence the runner exists
 * to surface.
 */
export function computePlan(
  files: readonly MigrationFile[],
  applied: ReadonlyMap<string, string>,
): Plan {
  const drift: DriftReason[] = [];
  const byVersion = new Map(files.map((file) => [file.version, file]));

  for (const [version, actual] of applied) {
    const file = byVersion.get(version);
    if (!file) {
      drift.push({ kind: "missing-from-disk", version });
      continue;
    }
    if (file.checksum !== actual) {
      drift.push({ kind: "checksum-mismatch", version, expected: file.checksum, actual });
    }
  }

  if (drift.length > 0) return { ok: false, drift };
  return { ok: true, pending: files.filter((file) => !applied.has(file.version)) };
}

// ---------------------------------------------------------------------------
// Database interaction. Everything below needs a live client; the pure functions above never do.
// ---------------------------------------------------------------------------

/** The table that records what has been applied. Its absence means "nothing applied yet", not an error. */
const MIGRATIONS_TABLE = "schema_migrations";

/** Session-scoped advisory lock key. Any constant works; this one is recognizable in `pg_locks`. */
const LOCK_KEY = "db-migrate-#593";

export interface RunOptions {
  /** Directory holding `NNN_name.sql` files. */
  dir: string;
  /** `status` prints what would run; `apply` writes. Status is the safe default at the CLI layer. */
  action: "status" | "apply";
}

export interface RunResult {
  ok: boolean;
  action: "status" | "apply";
  /** Versions that would run (status) or were planned (apply). */
  pending: string[];
  /** Versions this call actually applied. Always empty for status. */
  applied: string[];
  /** Present when ok is false because the database and the files disagree. */
  drift?: DriftReason[];
  /** Present when ok is false because a migration raised an error. */
  failed?: string;
  error?: string;
}

/** True when `schema_migrations` exists. Reading status must not create it — a read-only action stays read-only. */
export async function migrationsTableExists(client: Client): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "select to_regclass($1) is not null as present",
    [`public.${MIGRATIONS_TABLE}`],
  );
  return result.rows[0]?.present === true;
}

/** Create the ledger. Idempotent: a second run is a no-op. */
export async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(
    `create table if not exists ${MIGRATIONS_TABLE} (
       version text primary key,
       checksum text not null,
       applied_at timestamptz not null default now()
     )`,
  );
}

/** Read what the database says has been applied. Absent table means nothing applied. */
export async function loadApplied(client: Client): Promise<Map<string, string>> {
  if (!(await migrationsTableExists(client))) return new Map();
  const result = await client.query<{ version: string; checksum: string }>(
    `select version, checksum from ${MIGRATIONS_TABLE} order by version`,
  );
  return parseApplied(result.rows);
}

/**
 * Run a function while holding a session-scoped advisory lock, so two runners cannot interleave. The lock
 * is released in `finally`, including on throw, so a crashed run does not wedge the next one.
 *
 * Session-scoped rather than transaction-scoped because a run spans MULTIPLE transactions — one per
 * migration — and the lock must outlive each of them.
 */
export async function withAdvisoryLock<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query("select pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
  }
}

/**
 * Apply each pending file in its OWN transaction. A failure rolls back only that file: earlier files stay
 * applied and recorded, and later files do not run. The runner reports which version failed.
 */
export async function applyPending(
  client: Client,
  pending: readonly MigrationFile[],
): Promise<{ applied: string[]; failed?: string; error?: string }> {
  const applied: string[] = [];
  for (const migration of pending) {
    await client.query("begin");
    try {
      await client.query(migration.sql);
      await client.query(
        `insert into ${MIGRATIONS_TABLE} (version, checksum) values ($1, $2)`,
        [migration.version, migration.checksum],
      );
      await client.query("commit");
      applied.push(migration.version);
    } catch (error) {
      await client.query("rollback");
      return {
        applied,
        failed: migration.version,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { applied };
}

/**
 * The whole operation: read files, read applied state, compute the plan, and either report or write.
 *
 * Apply re-reads the applied state INSIDE the lock. Another runner may have finished between the caller's
 * plan and the lock being granted; trusting the earlier read would re-run migrations that already ran.
 */
export async function runMigrations(client: Client, options: RunOptions): Promise<RunResult> {
  const files = readMigrations(options.dir);
  const applied = await loadApplied(client);
  const plan = computePlan(files, applied);

  if (!plan.ok) {
    return { ok: false, action: options.action, pending: [], applied: [], drift: plan.drift };
  }
  if (options.action === "status") {
    return {
      ok: true,
      action: "status",
      pending: plan.pending.map((migration) => migration.version),
      applied: [],
    };
  }

  return withAdvisoryLock(client, async () => {
    await ensureMigrationsTable(client);
    const fresh = computePlan(files, await loadApplied(client));
    if (!fresh.ok) {
      return { ok: false, action: "apply", pending: [], applied: [], drift: fresh.drift };
    }
    const result = await applyPending(client, fresh.pending);
    return {
      ok: result.failed === undefined,
      action: "apply",
      pending: fresh.pending.map((migration) => migration.version),
      applied: result.applied,
      ...(result.failed === undefined ? {} : { failed: result.failed, error: result.error }),
    };
  });
}

// ---------------------------------------------------------------------------
// CLI. Argument parsing is a pure function so its rules are unit-testable without a database.
// ---------------------------------------------------------------------------

export const USAGE = `db-migrate — apply db/migrations/*.sql to a PostgreSQL database

Usage:
  npm run db:migrate -- --status [--database-url <url>]
  npm run db:migrate -- --apply  [--database-url <url>]

Flags:
  --status            Show what would run. Read-only: creates nothing, changes nothing. Default exit 1 when pending.
  --apply             Apply pending migrations in filename order. Exit 0 when applied or already up to date.
  --database-url <u>  Connection string. Overrides the environment.
  --help, -h          Print this help and exit 0.

DSN resolution order (first one set wins):
  1. --database-url
  2. DF_MIGRATE_DATABASE_URL
  3. DF_RUN_HISTORY_DATABASE_URL

Exit codes:
  0  applied successfully, or nothing pending
  1  drift (database and files disagree), a migration failed, or --status found pending work
  2  usage error: no action, no DSN, unknown flag
`;

export interface CliArgs {
  action: "status" | "apply";
  databaseUrl?: string;
  help: boolean;
}

export type ParseResult = { ok: true; args: CliArgs } | { ok: false; message: string };

/** Parse argv (without node and script). Exactly one action is required unless --help is present. */
export function parseArgs(argv: readonly string[]): ParseResult {
  let action: "status" | "apply" | undefined;
  let databaseUrl: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--status" || arg === "--apply") {
      if (action !== undefined) {
        return { ok: false, message: "choose exactly one of --status or --apply" };
      }
      action = arg === "--status" ? "status" : "apply";
    } else if (arg === "--database-url") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: "--database-url needs a value" };
      }
      databaseUrl = value;
      index += 1;
    } else if (arg.startsWith("--database-url=")) {
      databaseUrl = arg.slice("--database-url=".length);
    } else {
      return { ok: false, message: `unknown argument: ${arg}` };
    }
  }

  if (help) return { ok: true, args: { action: "status", help: true, databaseUrl } };
  if (action === undefined) return { ok: false, message: "choose --status (read-only) or --apply" };
  return { ok: true, args: { action, help: false, databaseUrl } };
}

/** First set value wins: flag, then the migrate-specific env var, then the run-history DSN as a fallback. */
export function resolveDsn(
  args: Pick<CliArgs, "databaseUrl">,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return args.databaseUrl ?? env.DF_MIGRATE_DATABASE_URL ?? env.DF_RUN_HISTORY_DATABASE_URL;
}

/**
 * CLI entry point. Guarded so importing this module from a test never connects to a database or exits the
 * process.
 */
async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`db-migrate: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const dsn = resolveDsn(parsed.args, process.env);
  if (dsn === undefined) {
    process.stderr.write(
      "db-migrate: no database URL. Pass --database-url or set DF_MIGRATE_DATABASE_URL (or DF_RUN_HISTORY_DATABASE_URL).\n",
    );
    return 2;
  }

  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    const dir = join(process.cwd(), "db", "migrations");
    const result = await runMigrations(client, { dir, action: parsed.args.action });

    if (!result.ok) {
      if (result.drift !== undefined) {
        process.stderr.write("db-migrate: refusing — the database and the migration files disagree:\n");
        for (const reason of result.drift) {
          if (reason.kind === "missing-from-disk") {
            process.stderr.write(`  ${reason.version} is applied but has no file in this checkout\n`);
          } else {
            process.stderr.write(
              `  ${reason.version} changed after it was applied (applied ${reason.actual}, file ${reason.expected})\n`,
            );
          }
        }
        process.stderr.write("Add a new migration; do not edit an applied file.\n");
      } else {
        process.stderr.write(`db-migrate: ${result.failed} failed: ${result.error}\n`);
      }
      return 1;
    }

    if (result.action === "status") {
      const applied = await loadApplied(client);
      process.stdout.write(`applied: ${applied.size}\n`);
      process.stdout.write(`pending: ${result.pending.length}\n`);
      for (const version of result.pending) process.stdout.write(`  ${version}\n`);
      return result.pending.length === 0 ? 0 : 1;
    }

    if (result.applied.length === 0) {
      process.stdout.write("up to date: nothing to apply\n");
    } else {
      for (const version of result.applied) process.stdout.write(`applied ${version}\n`);
    }
    return 0;
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `db-migrate: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
