import type { WorkspaceTools } from "./developer-agent";

/**
 * #280 (R1) — the provider-agnostic sandbox execution seam.
 *
 * The Developer Agent executes generated code through `WorkspaceTools`, which today is hard-wired to
 * the runner's own filesystem. This seam makes the backend configuration-selected, with the local
 * filesystem as the default, so a later release (R2, #281) can host the execution elsewhere without
 * changing the developer loop.
 *
 * `WorkspaceTools` stays where it is and is imported as a TYPE only. A type-only import is erased at
 * compile time, so this module cannot form a runtime import cycle with `developer-agent.ts`.
 *
 * Nothing here is on by default: absence of configuration means today's behaviour (see
 * `sandbox-provider.ts`).
 */

export type SandboxDriver = "local" | "dry-run" | "opensandbox" | "refusing";

/** #354 — the outcome of a git operation executed INSIDE the sandbox. */
export interface GitRunResult {
  exitCode: number;
  output: string;
}

export interface SandboxProvider {
  /** Short driver name, for logs and diagnostics. */
  readonly driver: SandboxDriver;
  /**
   * #354 — run a git operation INSIDE the sandbox. Present ONLY on the vault path, where the egress
   * sidecar injects the push credential, so the sandbox runs a bare CREDENTIAL-FREE command.
   *
   * Absent means git is the caller's job (the host-side push), which keeps every non-vault driver
   * byte-identical to today. Arguments are host-constructed and shell-quoting is the provider's
   * problem, so an implementation MUST reject anything it cannot quote safely.
   */
  runGit?(args: string[]): Promise<GitRunResult>;
  /**
   * True when generated code executes somewhere other than the runner's own filesystem. `local`,
   * `dry-run` and `refusing` are all NOT isolated — none of them executes anywhere else.
   */
  readonly isolated: boolean;
  /** Build the tools for a workspace directory. `local` must reproduce existing behaviour exactly. */
  create(
    workspaceDir: string,
    /**
     * #437 - lets a caller with a legitimately different command set STATE ITS OWN rather than widening
     * the shared test prefixes, which would widen what the Developer Agent may execute. Absent means the
     * shared list, exactly as before.
     */
    options?: { allowedCommands?: readonly string[] },
  ): WorkspaceTools;
  /**
   * Release any REMOTE resource this provider owns. Optional, because local/dry-run/refusing own none.
   *
   * This exists because closing a sandbox client does NOT terminate the sandbox: an orphan is both a
   * leak and spend, and a client timeout during create leaves one with no id the caller ever saw. The
   * coordinator calls this on success, on throw and on abort.
   */
  dispose?(): Promise<void>;
}

export class SandboxRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxRefusedError";
  }
}

/**
 * Tools that refuse EVERY operation without touching anything.
 *
 * This is deliberately not a "no-op success": a sandbox that cannot execute must be loud. A silent
 * no-op would let the developer loop believe it had read, written and tested code it never saw.
 */
function refusingTools(reason: string): WorkspaceTools {
  const refuse = (operation: string): never => {
    throw new SandboxRefusedError(`sandbox refused ${operation}: ${reason}`);
  };
  return {
    readFile: async (relPath: string) => refuse(`readFile('${relPath}')`),
    writeFile: async (relPath: string) => refuse(`writeFile('${relPath}')`),
    listFiles: async (pattern?: string) => refuse(`listFiles(${pattern ?? "no pattern"})`),
    runTests: async (cmd?: string) => refuse(`runTests(${cmd ?? "default command"})`),
  };
}

/** The fail-closed default: usable, but unable to do anything, and it says so. */
export function createRefusingSandboxProvider(reason: string): SandboxProvider {
  return {
    driver: "refusing",
    isolated: false,
    create: () => refusingTools(reason),
  };
}

/**
 * A dry run: the seam is wired, and no work is performed anywhere.
 *
 * It refuses rather than pretending to succeed, for the same reason as the refusing default — an
 * operation that reports success without executing is how a run claims progress it never made.
 */
export function createDryRunSandboxProvider(): SandboxProvider {
  return {
    driver: "dry-run",
    isolated: false,
    create: () => refusingTools("dry-run performs no work (nothing was read, written or executed)"),
  };
}
