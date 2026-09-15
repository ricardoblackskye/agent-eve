/**
 * Dark Factory — Containerised compute & code access (issues #130 / story #135).
 *
 * STUB — implementation pending (TDD RED).
 */

import type { CredentialBroker } from "./credentials";
import { MAX_TTL_SECONDS, REPO_PAIR_PATTERN, toRepoGrant } from "./credentials";
import type { DispatchEvent } from "./dispatch";
import type { MetricsStore, TaskStatus } from "./metrics";

export type WorkerRuntime = "node" | "python";

/** Canonical, provider-agnostic description of one unit of worker work. */
export interface WorkerTask {
  taskId: string;
  /** Normalised `owner/repo` the task may touch. */
  repo: string;
  runtime: WorkerRuntime;
  /** Command executed inside the sandbox. */
  command: string;
  /** Skeletal file map pushed into the environment before execution. */
  files: Record<string, string>;
  /** PBI / issue context pushed alongside the file map. */
  pbi?: string;
}

export class InvalidWorkerTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkerTaskError";
  }
}

export function toWorkerTask(input: {
  taskId?: string;
  repo?: string;
  runtime?: string;
  command?: string;
  files?: Record<string, string>;
  pbi?: string;
}): WorkerTask {
  const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
  if (!taskId) {
    throw new InvalidWorkerTaskError(
      `Worker task requires a non-empty "taskId" (received ${JSON.stringify(input.taskId)}).`,
    );
  }

  const repoRaw = typeof input.repo === "string" ? input.repo.trim() : "";
  if (!repoRaw) {
    throw new InvalidWorkerTaskError(
      `Worker task requires a non-empty "repo" (received ${JSON.stringify(input.repo)}).`,
    );
  }
  if (!REPO_PAIR_PATTERN.test(repoRaw)) {
    throw new InvalidWorkerTaskError(
      `Worker task "repo" ${JSON.stringify(repoRaw)} is not an owner/repo pair.`,
    );
  }

  const runtime = input.runtime;
  if (runtime !== "node" && runtime !== "python") {
    throw new InvalidWorkerTaskError(
      `Worker task requires "runtime" to be "node" or "python" (received ${JSON.stringify(runtime)}).`,
    );
  }

  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command) {
    throw new InvalidWorkerTaskError(
      `Worker task requires a non-empty "command" (received ${JSON.stringify(input.command)}).`,
    );
  }

  const task: WorkerTask = {
    taskId,
    repo: repoRaw.toLowerCase(),
    runtime,
    command,
    files: { ...(input.files ?? {}) },
  };
  if (typeof input.pbi === "string") task.pbi = input.pbi;
  return task;
}

/** What gets pushed into the sandbox before execution (AC2). */
export interface WorkerContext {
  fileMap: Record<string, string>;
  pbi?: string;
}

export interface WorkerHandle {
  handleId: string;
  task: WorkerTask;
  mode: "live" | "dry-run";
  /** True only when the provider really gives isolated compute. */
  isolated: boolean;
  /** The lease id — the sandbox never receives a token (AC5). */
  leaseId: string;
  repos: string[];
  contextPushed: boolean;
  destroyed: boolean;
}

export interface ProvisionResult {
  ok: boolean;
  mode: "live" | "dry-run";
  handle?: WorkerHandle;
  error?: string;
}

export interface PushResult {
  ok: boolean;
  error?: string;
}

export interface ExecResult {
  ok: boolean;
  mode: "live" | "dry-run";
  exitCode?: number;
  output?: string;
  error?: string;
}

export interface DestroyResult {
  ok: boolean;
  error?: string;
}

export interface WorkerProvider {
  id: string;
  mode: "live" | "dry-run";
  /** Whether this provider provides genuinely isolated compute. */
  isolated: boolean;
  provision(task: WorkerTask, credential: { leaseId: string; repos: string[] }): Promise<ProvisionResult>;
  pushContext(handle: WorkerHandle, context: WorkerContext): Promise<PushResult>;
  exec(handle: WorkerHandle, command: string): Promise<ExecResult>;
  destroy(handle: WorkerHandle): Promise<DestroyResult>;
}

export class LocalWorkerProvider implements WorkerProvider {
  id = "local";
  mode: "dry-run" | "live" = "dry-run";
  isolated = false;
  private handleCount = 0;
  private readonly contexts = new Map<string, WorkerContext>();

  async provision(
    task: WorkerTask,
    credential: { leaseId: string; repos: string[] },
  ): Promise<ProvisionResult> {
    this.handleCount += 1;
    const handle: WorkerHandle = {
      handleId: `local-handle-${this.handleCount}`,
      task,
      mode: "dry-run",
      isolated: false,
      // The lease id is the ONLY credential the sandbox receives.
      leaseId: credential.leaseId,
      repos: [...credential.repos],
      contextPushed: false,
      destroyed: false,
    };
    return { ok: true, mode: "dry-run", handle };
  }

  async pushContext(handle: WorkerHandle, context: WorkerContext): Promise<PushResult> {
    if (handle.destroyed) {
      return { ok: false, error: `Handle '${handle.handleId}' was already destroyed.` };
    }
    this.contexts.set(handle.handleId, {
      fileMap: { ...(context?.fileMap ?? {}) },
      ...(context?.pbi !== undefined ? { pbi: context.pbi } : {}),
    });
    handle.contextPushed = true;
    return { ok: true };
  }

  async exec(handle: WorkerHandle, command: string): Promise<ExecResult> {
    if (!handle.contextPushed) {
      // AC2: context must be readable INSIDE the environment before the worker's
      // logic executes, so executing first is a programming error, not a no-op.
      return {
        ok: false,
        mode: this.mode,
        error: `Refusing to execute: no context has been pushed for handle '${handle.handleId}'.`,
      };
    }
    if (handle.destroyed) {
      return { ok: false, mode: this.mode, error: `Handle '${handle.handleId}' was destroyed.` };
    }

    const context = this.contexts.get(handle.handleId);
    const files = Object.keys(context?.fileMap ?? {});
    return {
      ok: true,
      mode: this.mode,
      exitCode: 0,
      // Honest about what this is: nothing is executed in dry-run mode.
      output:
        `(dry-run) would run ${JSON.stringify(command)} with ${files.length} file(s) ` +
        `[${files.join(", ")}]${context?.pbi ? " and PBI context" : ""}`,
    };
  }

  async destroy(handle: WorkerHandle): Promise<DestroyResult> {
    // Idempotent: teardown is called from a finally block and may be retried.
    if (handle.destroyed) return { ok: true };
    handle.destroyed = true;
    this.contexts.delete(handle.handleId);
    return { ok: true };
  }
}

export function createWorkerProvider(
  env: Record<string, string | undefined> = process.env,
): WorkerProvider {
  const driver = (env.DF_WORKER_PROVIDER || "").trim().toLowerCase();
  if (driver === "" || driver === "local") return new LocalWorkerProvider();

  throw new Error(
    `DF_WORKER_PROVIDER '${driver}' is not available in R2 (only 'local', a dry-run provider, is ` +
      "implemented; the e2b/modal adapters land once keys exist). Leave it unset for the default.",
  );
}

export interface WorkerDeps {
  broker: CredentialBroker;
  provider: WorkerProvider;
  /** Repos a worker task may target; anything else is refused before provisioning. */
  allowedRepos: string[];
  /** Lease lifetime for a task. */
  ttlSeconds?: number;
}

export interface WorkerRunResult<T> {
  ok: boolean;
  status: 200 | 403 | 500;
  mode?: "live" | "dry-run";
  isolated?: boolean;
  result?: T;
  error?: string;
  destroyed: boolean;
}

export async function withWorker<T>(
  deps: WorkerDeps,
  task: WorkerTask,
  run: (handle: WorkerHandle) => Promise<T>,
): Promise<WorkerRunResult<T>> {
  const repo = task.repo.toLowerCase();
  const allowed = deps.allowedRepos.map((entry) => entry.trim().toLowerCase());

  // AC5: the repo check happens BEFORE provisioning, so a task aimed at a repo
  // the operator did not allow never gets a sandbox at all (403-shaped, no
  // side effects). This mirrors the fail-closed allow-list in #142.
  if (!allowed.includes(repo)) {
    return {
      ok: false,
      status: 403,
      destroyed: false,
      error:
        `Repo '${repo}' is not in the worker allow-list [${allowed.join(", ")}]. ` +
        "Refusing to provision a sandbox.",
    };
  }

  const issued = await deps.broker.issue(
    toRepoGrant({ repos: [repo], ttlSeconds: deps.ttlSeconds }),
  );
  if (!issued.ok || !issued.lease) {
    return {
      ok: false,
      status: 403,
      destroyed: false,
      error: issued.error ?? "Could not issue a worker lease.",
    };
  }
  const leaseId = issued.lease.leaseId;

  const provisioned = await deps.provider.provision(task, {
    leaseId,
    repos: issued.lease.repos,
  });
  if (!provisioned.ok || !provisioned.handle) {
    // Nothing was created, so there is nothing to tear down — but the lease must
    // not outlive the attempt.
    await deps.broker.revoke(leaseId);
    return {
      ok: false,
      status: 500,
      mode: provisioned.mode,
      destroyed: false,
      error: provisioned.error ?? "Provisioning failed.",
    };
  }

  const handle = provisioned.handle;
  let outcome: WorkerRunResult<T> = {
    ok: false,
    status: 500,
    destroyed: false,
    error: "Worker run did not complete.",
  };

  try {
    const pushed = await deps.provider.pushContext(handle, {
      fileMap: task.files,
      ...(task.pbi !== undefined ? { pbi: task.pbi } : {}),
    });
    if (!pushed.ok) {
      outcome = {
        ok: false,
        status: 500,
        mode: handle.mode,
        isolated: handle.isolated,
        destroyed: false,
        error: pushed.error ?? "Context push failed.",
      };
    } else {
      const result = await run(handle);
      outcome = {
        ok: true,
        status: 200,
        mode: handle.mode,
        isolated: handle.isolated,
        result,
        destroyed: false,
      };
    }
  } catch (err) {
    outcome = {
      ok: false,
      status: 500,
      mode: handle.mode,
      isolated: handle.isolated,
      destroyed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // AC4: teardown runs on EVERY path (success, throw, failed push) and its own
  // failure is reported rather than lost. The lease is released alongside it
  // (AC3 of #142), so a completed task leaves nothing usable behind.
  let destroyed = false;
  let teardownError: string | undefined;
  try {
    const destroyedResult = await deps.provider.destroy(handle);
    destroyed = destroyedResult.ok;
    if (!destroyedResult.ok) teardownError = destroyedResult.error;
  } catch (err) {
    teardownError = err instanceof Error ? err.message : String(err);
  }
  await deps.broker.revoke(leaseId);

  const final: WorkerRunResult<T> = { ...outcome, destroyed };
  if (teardownError) {
    final.error = final.error
      ? `${final.error} (teardown also failed: ${teardownError})`
      : `teardown failed: ${teardownError}`;
  }
  return final;
}

export interface WorkerHandlerDeps extends WorkerDeps {
  recorder?: MetricsStore;
  /** Builds the task for a dispatched event; defaults to a no-op probe task. */
  buildTask?: (event: DispatchEvent, worker: string) => WorkerTask;
}

/**
 * Dispatch-facing handler: turns a CI-failure event into a worker run.
 *
 * The default task is a PROBE — R2 ships the environment, not the worker agent
 * (that is R3), so nothing here pretends to write code. Supply `buildTask` to
 * drive real work. A failed run THROWS so the R1 Dispatcher applies its retry
 * policy and terminal-failure handling rather than silently swallowing it.
 */
export function createWorkerHandler(
  deps: WorkerHandlerDeps,
): (event: DispatchEvent, worker: string) => Promise<void> {
  return async (event, worker) => {
    const task = deps.buildTask
      ? deps.buildTask(event, worker)
      : toWorkerTask({
          taskId: `run-${event.runId}`,
          repo: event.repo,
          runtime: resolveWorkerRuntime(),
          command: "echo worker-ready",
          pbi: `CI ${event.status} for ${event.repo}@${event.ref} (run ${event.runId})`,
        });

    const outcome = await withWorker(deps, task, async (handle) => {
      const res = await deps.provider.exec(handle, task.command);
      if (!res.ok) throw new Error(res.error ?? "Worker execution failed.");
      return res.output;
    });

    if (deps.recorder) {
      try {
        await deps.recorder.record("worker-env", {
          iterations: 1,
          fixCycles: 0,
          status: outcome.ok ? "success" : "failure",
        });
      } catch {
        // A metrics problem must not fail the dispatch itself; wrap the recorder
        // in BufferedMetricsRecorder (#140) to retain records instead of losing them.
      }
    }

    if (!outcome.ok) {
      throw new Error(
        `Worker task '${task.taskId}' (worker '${worker}') failed: ${outcome.error ?? "unknown error"}`,
      );
    }
  };
}

/**
 * Reads `DF_WORKER_ALLOWED_REPOS` (comma-separated `owner/repo`).
 *
 * Fail-closed: an unset/blank list yields `[]`, which makes `withWorker` refuse
 * EVERY task with a 403 — an unconfigured deployment can provision nothing,
 * matching the `STORY_ALLOWED_REPOS` stance.
 */
export function resolveWorkerAllowedRepos(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = (env.DF_WORKER_ALLOWED_REPOS || "").trim();
  if (raw === "") return [];

  const repos: string[] = [];
  for (const entry of raw.split(",")) {
    const value = entry.trim().toLowerCase();
    if (value === "") continue;
    if (!REPO_PAIR_PATTERN.test(value)) {
      throw new Error(
        `DF_WORKER_ALLOWED_REPOS entry ${JSON.stringify(entry)} is not an owner/repo pair.`,
      );
    }
    repos.push(value);
  }
  return [...new Set(repos)];
}

/** Reads `DF_WORKER_RUNTIME` (`node` | `python`, default `node`). */
export function resolveWorkerRuntime(
  env: Record<string, string | undefined> = process.env,
): WorkerRuntime {
  const raw = (env.DF_WORKER_RUNTIME || "node").trim().toLowerCase();
  if (raw === "node" || raw === "python") return raw;

  throw new Error(
    `DF_WORKER_RUNTIME must be 'node' or 'python' (received ${JSON.stringify(env.DF_WORKER_RUNTIME)}).`,
  );
}

/** Reads `DF_CREDENTIAL_TTL_SECONDS` (1..3600, default 3600). */
export function resolveCredentialTtlSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env.DF_CREDENTIAL_TTL_SECONDS || "").trim();
  if (raw === "") return MAX_TTL_SECONDS;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_TTL_SECONDS) {
    throw new Error(
      `DF_CREDENTIAL_TTL_SECONDS must be an integer between 1 and ${MAX_TTL_SECONDS} ` +
        `(received ${JSON.stringify(env.DF_CREDENTIAL_TTL_SECONDS)}).`,
    );
  }
  return parsed;
}

export type { TaskStatus };
