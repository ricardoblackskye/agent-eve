import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  ConsoleStateProvider,
  SqliteStateAdapter,
  type StateStore,
} from "./state";

/**
 * Decide containment with the platform's own path comparison.
 *
 * `path.relative` is used rather than `startsWith(root + sep)` because
 * relative() follows the host's case sensitivity (Node's win32 implementation
 * compares case-insensitively, matching a case-insensitive filesystem, while
 * POSIX stays case-sensitive). A raw prefix compare false-rejected a legitimate
 * path whose drive letter differed in case ('c:\\x' vs 'C:\\x').
 */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep))
  );
}

/** Real-path resolver, injectable so the failure branch is testable off-filesystem. */
type RealpathFn = (path: string) => string;

/**
 * REAL path of the deepest ancestor of `target` that exists on disk, or `null`
 * when nothing along the chain exists.
 *
 * A state store file usually does not exist yet on first boot, so its own real
 * path cannot be resolved — walking up to the nearest existing directory is what
 * makes a link in the chain visible to `realpath`, which follows symlinks and
 * Windows junctions.
 *
 * Any failure OTHER than "does not exist" (EACCES, ELOOP, ENAMETOOLONG) means
 * containment cannot be verified at all. That REFUSES, naming the offending path
 * and the original cause: returning `null` and walking on would silently skip the
 * very check this function exists to perform.
 */
function realpathOfDeepestExistingAncestor(
  target: string,
  realpath: RealpathFn = realpathSync,
): string | null {
  let current = target;
  for (;;) {
    try {
      return realpath(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new Error(
          `Path '${target}' could not be resolved for a containment check ` +
            `(${code ?? "unknown"}: ${(error as Error).message}). Refusing to open a ` +
            "state store whose real path cannot be verified.",
        );
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Canonicalise the configured SQLite path and, when `DF_STATE_DB_DIR` is set,
 * refuse anything that resolves outside that directory.
 *
 * `DF_STATE_DB_PATH` comes from the environment, which is operator-controlled
 * configuration rather than request input (the same trust boundary as the GitHub
 * tokens this repo already reads from env), so the default trusts the operator.
 * The optional sandbox root is defence in depth for deployments that want to
 * bound where state may be written — and it follows the fail-closed shape of the
 * `STORY_ALLOWED_REPOS` allow-list: once configured, an escaping path is
 * REFUSED rather than silently used. Canonicalising also means an error message
 * names the real target, not a `../..`-laden string.
 *
 * Containment is decided lexically first and then re-checked against the REAL
 * path of the deepest existing ancestor, so a symlink or junction inside the
 * sandbox that points outside it is REFUSED rather than opened. The second check
 * exists because path string maths cannot see a link: `path.resolve` is lexical,
 * and this function previously admitted such a path (see #160).
 */
export function resolveStateDbPath(
  rawPath: string,
  sandboxRoot?: string,
  realpath: RealpathFn = realpathSync,
): string {
  const resolved = resolve(rawPath);
  const root = (sandboxRoot || "").trim();
  if (root === "") return resolved;

  const resolvedRoot = resolve(root);
  if (!isInside(resolvedRoot, resolved)) {
    throw new Error(
      `DF_STATE_DB_PATH '${resolved}' resolves outside DF_STATE_DB_DIR '${resolvedRoot}'. ` +
        "Refusing to open a state store outside the configured sandbox root.",
    );
  }

  // The lexical check above cannot see a link, so re-check where the path
  // actually LANDS. The store file usually does not exist yet, so the deepest
  // existing ancestor is what is resolved — any link in that chain is followed
  // by realpath. When nothing along the chain exists there can be no link
  // either, and the lexical decision stands.
  const realRoot = realpathOfDeepestExistingAncestor(resolvedRoot, realpath);
  const realTarget = realpathOfDeepestExistingAncestor(resolved, realpath);
  if (
    realRoot !== null &&
    realTarget !== null &&
    !isInside(realRoot, realTarget)
  ) {
    throw new Error(
      `DF_STATE_DB_PATH '${resolved}' resolves outside DF_STATE_DB_DIR '${resolvedRoot}' ` +
        `via a link to '${realTarget}'. Refusing to open a state store outside the ` +
        "configured sandbox root.",
    );
  }

  return resolved;
}

/**
 * Choose the execution-memory store from the environment.
 *
 * `DF_STATE_DRIVER` unset/empty -> fail-closed `console` provider (refuses every
 * write rather than pretending to persist). `sqlite` -> the file-backed adapter,
 * which requires `DF_STATE_DB_PATH`. Anything else is a configuration error and
 * throws rather than silently degrading to a store that loses state.
 */
export function createStateStore(
  env: Record<string, string | undefined> = process.env,
): StateStore {
  const driver = (env.DF_STATE_DRIVER || "").trim();
  if (driver === "") return new ConsoleStateProvider();

  if (driver === "sqlite") {
    const dbPath = (env.DF_STATE_DB_PATH || "").trim();
    if (!dbPath) {
      throw new Error(
        "DF_STATE_DRIVER=sqlite requires DF_STATE_DB_PATH (filesystem path to the SQLite database).",
      );
    }
    return new SqliteStateAdapter(
      resolveStateDbPath(dbPath, env.DF_STATE_DB_DIR),
    );
  }

  throw new Error(
    `Unknown DF_STATE_DRIVER '${driver}'. Supported drivers: sqlite (leave unset for the fail-closed console default).`,
  );
}
