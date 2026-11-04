import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

/**
 * CLI entry point. Guarded so importing this module from a test never connects to a database or exits the
 * process. The full flag surface arrives in Task 6; for now an unrecognised invocation explains itself.
 */
async function main(): Promise<number> {
  process.stderr.write(
    "db-migrate: not yet implemented. Planned flags: --status (default, read-only), --apply, --database-url.\n",
  );
  return 2;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
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
