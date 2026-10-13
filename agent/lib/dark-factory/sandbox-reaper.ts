/**
 * #281 (R2b/B4) — reap orphaned sandboxes by run id.
 *
 * A client timeout during `Sandbox.create` can leave a sandbox the caller never saw (observed live: the
 * server kept building after the client gave up, and it had to be reaped by hand). Every sandbox this
 * runner creates is labelled with `metadata.run`, so a reaping pass keyed on that label reclaims any
 * orphan from a prior run with the same id before the run starts. The primary release is
 * runCodingPhase's dispose(); this is defense in depth.
 */
import { ConnectionConfig, SandboxManager } from "@alibaba-group/opensandbox";

import { sandboxConnectionConfig } from "./opensandbox-driver";

/** The slice of the SDK the reaper uses, declared structurally so tests need no live manager. */
export interface SandboxManagerLike {
  listSandboxInfos(filter?: {
    metadata?: Record<string, string>;
    states?: string[];
  }): Promise<{ items: Array<{ id: string }> }>;
  killSandbox(sandboxId: string, signal?: AbortSignal): Promise<void>;
}

export interface ReapOptions {
  runId: string;
  /** Optional lifecycle-state filter (e.g. only still-running sandboxes). */
  states?: string[];
  /** Inject a manager (tests). When absent, one is built from the environment. */
  manager?: SandboxManagerLike;
}

function managerFromEnv(): SandboxManagerLike {
  return SandboxManager.create({ connectionConfig: sandboxConnectionConfig() });
}

/** Returns the ids reaped. Delete failures are swallowed: a stuck orphan must not abort the run. */
export async function reapSandboxesByRun(opts: ReapOptions): Promise<string[]> {
  const manager = opts.manager ?? managerFromEnv();
  const listed = await manager.listSandboxInfos({
    metadata: { run: opts.runId },
    ...(opts.states ? { states: opts.states } : {}),
  });
  const ids = listed.items.map((item) => item.id);
  for (const id of ids) {
    await manager.killSandbox(id).catch(() => undefined);
  }
  return ids;
}
