/**
 * Operator-script environment loading.
 *
 * Next loads `.env.local` for the APP; a bare `tsx scripts/...` never sees it.
 * That split means the same variable can be set in one place and silently
 * missing in the other — the seed then reports success while writing nothing.
 *
 * These files fill in ONLY what the shell did not provide, so an explicitly
 * exported value (a production DSN, a CI secret) always stays authoritative.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
export function loadLocalEnv(dir: string = process.cwd()): string[] {
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
