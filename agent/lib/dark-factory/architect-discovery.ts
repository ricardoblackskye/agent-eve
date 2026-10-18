/**
 * Dark Factory — Architect discovery (#381 R1).
 *
 * The Architect plans from a file LIST and cannot tell a page from a shared component from the application
 * shell. This module derives that from the repository: which file is routed for the surface a story names,
 * what each reachable file IS, and the composition path that proves it.
 *
 * Deterministic by design: no model call is made here. The evidence it returns is fed into the single
 * governed planning call, so cost stays one call per plan attempt.
 */

export type FileRole = "route" | "shell" | "page" | "shared" | "component";

export interface DiscoveredFile {
  /** Repo-relative, posix separators. */
  path: string;
  role: FileRole;
  /** The composition path that proves the role, cited by the plan's rationale. */
  evidence: string;
}

export interface DiscoveryInput {
  /** The repository's files, as the runner lists them. */
  files: string[];
  /** Injected so discovery can be tested without a filesystem, and be bounded by the caller. */
  readFile: (path: string) => Promise<string>;
  story: { title: string; body: string };
  /** Bounds the number of INSPECTION reads discovery itself performs. */
  maxInspectReads: number;
}

export interface DiscoveryResult {
  /** The composition chain for the named surface, if one could be resolved. */
  chain: DiscoveredFile[];
  /** Every file whose role was classified, chain files first. */
  classified: DiscoveredFile[];
  /** The resolved surface, or undefined when the story's surface could not be derived. */
  surface?: { route?: string; page?: string };
}

/** Discover the composition chain and file roles for the surface a story names. */
export async function discoverArchitecture(_input: DiscoveryInput): Promise<DiscoveryResult> {
  throw new Error("not implemented");
}
