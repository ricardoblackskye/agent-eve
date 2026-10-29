/**
 * Operator-script environment loading.
 *
 * Next loads `.env.local` for the APP; a bare `tsx scripts/...` never sees it.
 * That split means the same variable can be set in one place and silently
 * missing in the other — the seed then reports success while writing nothing.
 *
 * These files fill in ONLY what the shell did not provide, so an explicitly
 * exported value (a production DSN, a CI secret) always stays authoritative.
 *
 * The directory is the AGENT repository root, resolved from this module rather than
 * from the process (#540). Two reasons, and the second is the important one: a local
 * run's working directory is a checkout of the TARGET repository, so resolving from
 * the cwd found no `.env.local` at all - and if the target happened to have one, it
 * would be that project's configuration, never the agent's credentials.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This module's own directory: `scripts/`. */
const HERE = dirname(fileURLToPath(import.meta.url));
/** The agent repository root — one level above `scripts/`. */
const REPO_ROOT = resolve(HERE, "..");

const FILES = [".env.local", ".env"] as const;

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Load `.env.local` then `.env` from `dir` into `process.env`, without
 * overriding anything already set. Returns the names it supplied, so a script
 * can report which file configured it.
 */
/**
 * The directory the default loads from (#540): the AGENT repository root.
 *
 * Exported so the rule can be asserted: CI has no `.env.local` at the repository root, so a test that proved
 * this through the filesystem could only pass on a machine that happens to have one.
 */
export function localEnvDir(): string {
  return REPO_ROOT;
}

export function loadLocalEnv(dir: string = localEnvDir()): string[] {
  const supplied: string[] = [];

  for (const name of FILES) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;

    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match =
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1] as string;
      if (process.env[key] !== undefined) continue;
      process.env[key] = unquote((match[2] ?? "").trim());
      supplied.push(key);
    }
  }

  return supplied;
}
