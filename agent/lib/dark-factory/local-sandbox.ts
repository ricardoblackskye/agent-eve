import { createWorkspaceTools } from "./developer-agent";
import type { SandboxProvider } from "./sandbox";

/**
 * #280 (R1) — the local adapter, which must reproduce today's behaviour EXACTLY.
 *
 * It delegates to `createWorkspaceTools` rather than reimplementing it, so every existing guard
 * (path traversal, symlink containment, extension allowlist, test-command allowlist) keeps running
 * unchanged, and there is no second implementation to drift from the first.
 */
export function createLocalSandboxProvider(): SandboxProvider {
  return {
    driver: "local",
    isolated: false,
    create: (workspaceDir: string) => createWorkspaceTools(workspaceDir),
  };
}
