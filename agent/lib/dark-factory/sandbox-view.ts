/**
 * #790 R1 (#791) - observing a local sandbox, read-only.
 *
 * Route A (expose a port and run code-server inside the sandbox) was rejected: it hands the operator a shell, which
 * contradicts AC2 - "the view grants no write access". Route B reads the workspace through the file API the driver
 * already has, and is read-only BY CONSTRUCTION: there is no write path to reach and no shell to reach one through.
 *
 * Two properties are decided here rather than at the call site, because both are the kind that get lost when left to
 * whoever wires the feature up:
 *
 *   1. The reader cannot write and cannot exec. `WorkspaceReader` requires only the read operations, so the write path
 *      is not merely unused - it is not reachable through the type this module accepts.
 *
 *   2. The reader refuses credential-bearing paths. The vault is write-only (#354, the egress sidecar substitutes
 *      downstream) so vault values never touch the filesystem, but a workspace cloned from a real repository can hold
 *      `.env`, `.git-credentials` and key material. "Assume there are none" is not a guard; a filter is.
 *
 * Scope is R1's: local sandboxes only. No ingress, no tunnel, no new provider, and - under route B - no new listener
 * either. The view is served by the app the operator already has open.
 */

/** One entry in the workspace, as the sandbox's own directory listing reports it. */
export interface WorkspaceEntry {
  path: string;
  type?: string;
  name?: string;
}

/**
 * The slice of a sandbox handle this module accepts.
 *
 * Deliberately read-only. `writeFiles`, `commands.run` and the rest exist on the real handle; they are absent here so
 * an implementation cannot quietly reach for one, and so the compiler refuses if it tries.
 */
export interface WorkspaceReader {
  files: {
    listDirectory(entry: { path: string; depth?: number }): Promise<WorkspaceEntry[]>;
    readFile(path: string): Promise<unknown>;
  };
}

/** Exact filenames that carry credentials wherever they sit in the tree. */
const DENIED_BASENAMES = new Set([
  ".git-credentials",
  ".netrc",
  "_netrc",
  ".npmrc",
  ".htpasswd",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials.json",
]);

/** Filename prefixes that carry credentials with a varying suffix (.env.local, .env.production, ...). */
const DENIED_BASENAME_PREFIXES = [".env"];

/** Extensions that are key or certificate material rather than source. */
const DENIED_EXTENSIONS = new Set([".pem", ".key", ".crt", ".cer", ".p12", ".pfx", ".jks"]);

/** Path segments that are a write-shaped surface, or simply not the operator's business in a read-only view. */
const DENIED_SEGMENTS = new Set([".git", ".ssh", ".aws", ".gnupg", "node_modules"]);

function normalize(path: string): string {
  // Both separators, because a Windows-run sandbox reports whichever it reports, and a filter that only understands one
  // is a filter with a way around it.
  return path.replace(/\\/g, "/").trim();
}

function basename(path: string): string {
  const parts = normalize(path).split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * May this path be served through the view?
 *
 * Refuses credential-bearing files, key material, git and cloud credential directories, and any path that escapes the
 * workspace. Traversal is refused on the way in rather than trusted from a listing, because a listing is exactly what
 * a compromised workspace would control.
 */
export function isViewablePath(path: string): boolean {
  const normalized = normalize(path);
  if (normalized === "") return false;

  const segments = normalized.split("/");

  // Escape the workspace - the one input that could leave it entirely.
  if (segments.includes("..")) return false;

  if (segments.some((segment) => DENIED_SEGMENTS.has(segment.toLowerCase()))) return false;

  const name = basename(normalized);
  const lower = name.toLowerCase();

  if (DENIED_BASENAMES.has(lower)) return false;
  if (DENIED_BASENAME_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;

  const dot = lower.lastIndexOf(".");
  if (dot > 0 && DENIED_EXTENSIONS.has(lower.slice(dot))) return false;

  return true;
}

export interface ListViewableOptions {
  handle: WorkspaceReader;
  /** Workspace-relative or sandbox-absolute directory to list. */
  path: string;
  depth?: number;
}

/**
 * List the workspace, omitting anything the view may not serve.
 *
 * A denied entry is dropped rather than thrown on: one secret in the tree must not blind the operator to the rest of
 * the run. Only `files.listDirectory` is called - the type makes any other route unrepresentable here.
 */
export async function listViewableEntries(options: ListViewableOptions): Promise<WorkspaceEntry[]> {
  const entries = await options.handle.files.listDirectory({
    path: options.path,
    ...(options.depth === undefined ? {} : { depth: options.depth }),
  });

  return entries.filter((entry) => isViewablePath(entry.path));
}
