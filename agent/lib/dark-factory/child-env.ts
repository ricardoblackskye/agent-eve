/**
 * Dark Factory — the ONE allow-list of environment variables an agent may hand to a
 * CHILD PROCESS (#275).
 *
 * WHY THIS EXISTS: `child_process.exec`/`execFile` INHERIT the parent environment when
 * no `env` is passed. In a deployed runtime that environment holds the operator's push
 * token, every `DF_*` knob, and any database URL — so a command run by an agent could
 * read and exfiltrate all of it. The tester agent has filtered this since it was
 * written; the developer agent did NOT (that is #275's "verify dev-agent env filtering
 * like tester-agent"), and a second copy of the list would reproduce exactly that drift.
 * Both now consume THIS module.
 *
 * KEEP IT MINIMAL (#275 decision 1): only what a test runner genuinely needs to resolve
 * an executable and a home/temp directory. Anything a child could use to reach a network
 * secret is deliberately absent.
 */

/** The only environment keys a Dark Factory child process may receive. */
export const ALLOWED_CHILD_ENV_KEYS: ReadonlySet<string> = new Set([
  "NODE_PATH",
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
]);

/**
 * Return ONLY the allow-listed keys from `source`.
 *
 * Fail-closed: a missing or malformed source yields an EMPTY object, never the parent
 * environment. Keys are matched exactly (no case folding, so a lowercase `path` cannot
 * be smuggled in on POSIX) and values are preserved verbatim.
 */
export function filterChildEnv(
  source: Record<string, string | undefined> | undefined,
): Record<string, string> {
  if (!source) return {};
  const filtered: Record<string, string> = {};
  for (const key of ALLOWED_CHILD_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string") filtered[key] = value;
  }
  return filtered;
}
