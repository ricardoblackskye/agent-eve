import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Containment by `path.relative`, never by a string prefix.
 *
 * `path.resolve` does not normalise case, so a prefix compare false-rejects a
 * legitimate path whose drive letter differs; on Windows a case-insensitive
 * filesystem also makes the prefix test subtly wrong in the other direction.
 * `relative` follows the platform instead. `isAbsolute(rel)` catches a path that
 * resolves to a different drive/root.
 */
function escapesRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Join `segments` under `root`, throwing if the result escapes `root`.
 *  Returns `join(root, ...segments)` (NOT `resolve`) so the result keeps the same
 *  relative/absolute form the caller built `root` with — resolving would turn a
 *  `C:/ws` base into `/home/.../C:/ws` on Linux and break `startsWith(root)`. */
export function safeJoin(root: string, ...segments: string[]): string {
  const target = join(root, ...segments);
  if (escapesRoot(root, target)) {
    throw new Error(`refusing a path outside ${root}: ${target}`);
  }
  return target;
}

/** Return `target` resolved, throwing if it is not inside `root`. */
export function safeReadWithin(root: string, target: string): string {
  const resolved = resolve(target);
  if (escapesRoot(root, resolved)) {
    throw new Error(`refusing a read outside ${root}: ${resolved}`);
  }
  return resolved;
}
