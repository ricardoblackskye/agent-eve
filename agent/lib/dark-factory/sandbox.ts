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

export type SandboxDriver = "local" | "dry-run" | "refusing";

export interface SandboxProvider {
  /** Short driver name, for logs and diagnostics. */
  readonly driver: SandboxDriver;
  /**
   * True when generated code executes somewhere other than the runner's own filesystem. `local`,
   * `dry-run` and `refusing` are all NOT isolated — none of them executes anywhere else.
   */
  readonly isolated: boolean;
  /** Build the tools for a workspace directory. `local` must reproduce existing behaviour exactly. */
  create(workspaceDir: string): WorkspaceTools;
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
