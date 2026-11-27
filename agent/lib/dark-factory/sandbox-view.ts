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
// ---------------------------------------------------------------------------
// Reaching a live LOCAL sandbox (#790 R1, tasks 4 and 6)
// ---------------------------------------------------------------------------
//
// Route B needs one thing route A did not: evidence that the sandbox it reads is on THIS machine. The view is served by
// the operator's own console, so "local" is not a UI decision - it is the endpoint the run's sandbox was reached at
// (`DF_SANDBOX_ENDPOINT`, documented as `host[:port]`, loopback by default). A remote or cluster endpoint yields NO
// view, and never a hint that one exists. That is AC3's risk in its honest route-B form: the exposure that cannot be
// created is the one that cannot default to 0.0.0.0.

/** The workspace inside the sandbox, matching the driver's own default. */
export const DEFAULT_VIEW_WORKSPACE = "/workspace";

/** Hosts that mean "this machine". Anything else is remote, and R1 does not serve remote sandboxes. */
export const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "0:0:0:0:0:0:0:1",
]);

/**
 * The manager slice the view accepts: LISTING ONLY.
 *
 * The real `SandboxManager` can also `killSandbox`, `pauseSandbox` and `renewSandbox`. None of them belong within reach
 * of a read-only view of somebody's running run, so none of them are in this type - an implementation that reached for
 * one would not compile, and the run's own lifecycle stays the run's business.
 */
export interface SandboxManagerLike {
  listSandboxInfos(filter?: {
    metadata?: Record<string, string>;
    states?: string[];
  }): Promise<{ items: Array<{ id: string }> }>;
}

/** A connected sandbox client, narrowed to what the view may do with one: read, and release the transport. */
export interface SandboxViewClient extends WorkspaceReader {
  close?(): Promise<void>;
}

export interface SandboxViewSession {
  sandboxId: string;
  /** Absolute path inside the sandbox that the view lists and reads. */
  workspace: string;
  reader: WorkspaceReader;
  /**
   * Release the client transport this view opened.
   *
   * NOT a teardown of the sandbox: the run owns it, and an observer leaving must cost the run nothing.
   */
  release(): Promise<void>;
}

/** Why a view is not on offer. Each is a different sentence to the operator, so they are not flattened into one. */
export type SandboxViewReason =
  | "not-local"
  | "no-live-sandbox"
  | "unreachable"
  | "unreadable";

export type SandboxViewOpenResult =
  | { ok: true; session: SandboxViewSession }
  | { ok: false; reason: SandboxViewReason; message: string };

export interface OpenSandboxViewOptions {
  runId: string;
  env?: Record<string, string | undefined>;
  manager?: SandboxManagerLike;
  connect?: (
    sandboxId: string,
    env: Record<string, string | undefined>,
  ) => Promise<SandboxViewClient>;
}

/**
 * Is this endpoint one this machine can read a sandbox through?
 *
 * Unset or blank counts as local because the driver's own default is `127.0.0.1:8080`; `0.0.0.0` does NOT, because it
 * is a listen-all address rather than a place to connect to.
 */
export function isLocalSandboxEndpoint(endpoint: string | undefined): boolean {
  throw new Error("not implemented");
}

/**
 * Open a read-only view of the run's live sandbox, or say why there is none.
 */
export async function openSandboxView(
  options: OpenSandboxViewOptions,
): Promise<SandboxViewOpenResult> {
  throw new Error("not implemented");
}
