/**
 * #582 (version coupling) - the CLI exposes its version so the Windows program can verify it.
 *
 * The #584 epic requires the program to declare a minimum Eve version and refuse a checkout it
 * does not support; for that it must be able to read this CLI's version cheaply and without
 * running a full provision. This module is the single source: package.json at the repo root.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The package version (semver) the CLI was built from. */
export function getCliVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}
