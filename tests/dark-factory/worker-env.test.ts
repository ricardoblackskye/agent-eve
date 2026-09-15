import { describe, it, expect } from "vitest";
import {
  toWorkerTask,
  InvalidWorkerTaskError,
  LocalWorkerProvider,
  createWorkerProvider,
  createWorkerHandler,
  resolveWorkerAllowedRepos,
  resolveWorkerRuntime,
  resolveCredentialTtlSeconds,
  withWorker,
  type WorkerProvider,
} from "../../agent/lib/dark-factory/worker-env";
import { LocalCredentialBroker } from "../../agent/lib/dark-factory/credentials";
import { toDispatchEvent } from "../../agent/lib/dark-factory/dispatch";
import { InMemoryMetricsStore } from "../../agent/lib/dark-factory/metrics";

const REPO = "ricardoblackskye/agent-eve";

const makeTask = () =>
  toWorkerTask({
    taskId: "t-1",
    repo: REPO,
    runtime: "node",
    command: "npm test",
    files: { "src/a.ts": "export const a = 1;" },
    pbi: "PBI: make the thing work",
  });

describe("WorkerTask canonical payload (#135 AC1)", () => {
  it("keeps the canonical fields and normalises the repo identifier", () => {
    const task = toWorkerTask({
      taskId: "  t-1  ",
      repo: "RicardoBlackSkye/Agent-Eve",
      runtime: "node",
      command: "npm test",
      files: { "a.ts": "1" },
      pbi: "p",
    });

    expect(task).toEqual({
      taskId: "t-1",
      repo: REPO,
      runtime: "node",
      command: "npm test",
      files: { "a.ts": "1" },
      pbi: "p",
    });
  });

  it("defaults files to an empty map when omitted", () => {
    const task = toWorkerTask({ taskId: "t", repo: REPO, runtime: "python", command: "python x.py" });

    expect(task.files).toEqual({});
  });

  it("rejects a missing taskId, repo or command, naming the field", () => {
    expect(() => toWorkerTask({ repo: REPO, runtime: "node", command: "x" })).toThrow(/taskId/);
    expect(() => toWorkerTask({ taskId: "t", runtime: "node", command: "x" })).toThrow(/repo/);
    expect(() => toWorkerTask({ taskId: "t", repo: REPO, runtime: "node" })).toThrow(
      InvalidWorkerTaskError,
    );
  });

  it("rejects an unsupported runtime", () => {
    expect(() =>
      toWorkerTask({ taskId: "t", repo: REPO, runtime: "ruby", command: "x" }),
    ).toThrow(/runtime/);
  });

  it("rejects a malformed repo identifier", () => {
    expect(() => toWorkerTask({ taskId: "t", repo: "agent-eve", runtime: "node", command: "x" })).toThrow(
      /owner\/repo/,
    );
  });
});

describe("worker provider seam + local dry-run default (#135 AC1/AC3)", () => {
  it("is the default and HONESTLY reports it is not isolated", async () => {
    const provider = createWorkerProvider({});

    expect(provider.id).toBe("local");
    expect(provider.mode).toBe("dry-run");
    expect(provider.isolated).toBe(false);
  });

  it("accepts an explicit local driver and refuses an unimplemented one by name", () => {
    expect(createWorkerProvider({ DF_WORKER_PROVIDER: "local" }).id).toBe("local");
    expect(() => createWorkerProvider({ DF_WORKER_PROVIDER: "e2b" })).toThrow(/e2b/);
  });

  it("provisions a handle that carries the LEASE and never a token", async () => {
    const provider = new LocalWorkerProvider();

    const res = await provider.provision(makeTask(), { leaseId: "lease-1", repos: [REPO] });

    expect(res.ok).toBe(true);
    expect(res.handle?.mode).toBe("dry-run");
    expect(res.handle?.isolated).toBe(false);
    expect(res.handle?.leaseId).toBe("lease-1");
    expect(res.handle?.repos).toEqual([REPO]);
    expect(res.handle?.destroyed).toBe(false);
    expect(JSON.stringify(res.handle)).not.toMatch(/token|ghp_/i);
  });

  it("mints a distinct handle per task", async () => {
    const provider = new LocalWorkerProvider();

    const a = await provider.provision(makeTask(), { leaseId: "l1", repos: [REPO] });
    const b = await provider.provision(makeTask(), { leaseId: "l2", repos: [REPO] });

    expect(a.handle?.handleId).not.toBe(b.handle?.handleId);
  });
});

/** Provider that records its lifecycle calls so teardown can be asserted. */
class RecordingProvider extends LocalWorkerProvider {
  calls: string[] = [];
  failPush = false;

  override async provision(
    task: Parameters<LocalWorkerProvider["provision"]>[0],
    credential: Parameters<LocalWorkerProvider["provision"]>[1],
  ) {
    this.calls.push("provision");
    return super.provision(task, credential);
  }

  override async pushContext(
    handle: Parameters<LocalWorkerProvider["pushContext"]>[0],
    context: Parameters<LocalWorkerProvider["pushContext"]>[1],
  ) {
    this.calls.push("pushContext");
    if (this.failPush) return { ok: false, error: "context push failed" };
    return super.pushContext(handle, context);
  }

  override async exec(
    handle: Parameters<LocalWorkerProvider["exec"]>[0],
    command: string,
  ) {
    this.calls.push("exec");
    return super.exec(handle, command);
  }

  override async destroy(handle: Parameters<LocalWorkerProvider["destroy"]>[0]) {
    this.calls.push("destroy");
    return super.destroy(handle);
  }
}

describe("context must be pushed before execution (#135 AC2)", () => {
  it("refuses to exec before any context push", async () => {
    const provider = new LocalWorkerProvider();
    const { handle } = await provider.provision(makeTask(), { leaseId: "l1", repos: [REPO] });

    const res = await provider.exec(handle!, "npm test");

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/context/i);
    expect(res.mode).toBe("dry-run");
  });

  it("makes the pushed context what the execution step sees", async () => {
    const provider = new LocalWorkerProvider();
    const { handle } = await provider.provision(makeTask(), { leaseId: "l1", repos: [REPO] });

    const push = await provider.pushContext(handle!, {
      fileMap: { "src/a.ts": "let a = 1;" },
      pbi: "PBI text",
    });

    expect(push.ok).toBe(true);
    expect(handle?.contextPushed).toBe(true);

    const res = await provider.exec(handle!, "npm test");
    expect(res.ok).toBe(true);
    expect(res.output).toContain("src/a.ts");
  });
});

describe("unconditional teardown + credential wiring (#135 AC4/AC5)", () => {
  const SECRET = "ghp_SUPERSECRET_TOKEN_VALUE";
  const deps = (provider: WorkerProvider) => ({
    broker: new LocalCredentialBroker({ token: SECRET, now: () => 1_000 }),
    provider,
    allowedRepos: [REPO],
  });

  it("runs provision -> pushContext -> exec -> destroy and returns the result", async () => {
    const provider = new RecordingProvider();

    const out = await withWorker(deps(provider), makeTask(), async (handle) => {
      const res = await provider.exec(handle, handle.task.command);
      return res.output;
    });

    expect(out.ok).toBe(true);
    expect(out.status).toBe(200);
    expect(out.mode).toBe("dry-run");
    expect(out.isolated).toBe(false);
    expect(out.destroyed).toBe(true);
    expect(provider.calls).toEqual(["provision", "pushContext", "exec", "destroy"]);
  });

  it("hands the sandbox a LEASE and never a token", async () => {
    const provider = new RecordingProvider();
    let serialised = "";

    await withWorker(deps(provider), makeTask(), async (handle) => {
      serialised = JSON.stringify(handle);
      expect(handle.leaseId).toBeTruthy();
      expect(handle.repos).toEqual([REPO]);
      return "ok";
    });

    expect(serialised).not.toContain(SECRET);
  });

  it("tears down when the worker callback throws, and surfaces the failure", async () => {
    const provider = new RecordingProvider();

    const out = await withWorker(deps(provider), makeTask(), async () => {
      throw new Error("worker exploded");
    });

    expect(out.ok).toBe(false);
    expect(out.status).toBe(500);
    expect(out.error).toMatch(/worker exploded/);
    expect(out.destroyed).toBe(true);
    expect(provider.calls).toContain("destroy");
  });

  it("tears down when the context push fails, and never executes", async () => {
    const provider = new RecordingProvider();
    provider.failPush = true;
    let ran = false;

    const out = await withWorker(deps(provider), makeTask(), async () => {
      ran = true;
      return "unreachable";
    });

    expect(out.ok).toBe(false);
    expect(ran).toBe(false);
    expect(out.destroyed).toBe(true);
    expect(provider.calls).toEqual(["provision", "pushContext", "destroy"]);
  });

  it("refuses a repo outside the allow-list BEFORE provisioning anything", async () => {
    const provider = new RecordingProvider();
    const foreign = toWorkerTask({
      taskId: "t-2",
      repo: "someone/else",
      runtime: "node",
      command: "npm test",
    });

    const out = await withWorker(deps(provider), foreign, async () => "unreachable");

    expect(out.ok).toBe(false);
    expect(out.status).toBe(403);
    expect(out.error).toMatch(/allow/i);
    expect(provider.calls).toEqual([]);
  });
});

describe("createWorkerHandler — dispatch integration (#135 AC5 + R1 seam)", () => {
  const SECRET = "ghp_SUPERSECRET_TOKEN_VALUE";
  const event = { runId: "run-1", repo: REPO, ref: "main", status: "failure" as const };

  const makeDeps = (
    provider: RecordingProvider,
    recorder?: InMemoryMetricsStore,
    allowedRepos: string[] = [REPO],
  ) => ({
    broker: new LocalCredentialBroker({ token: SECRET, now: () => 1_000 }),
    provider,
    allowedRepos,
    recorder,
  });

  it("runs the full path and records a success metric", async () => {
    const provider = new RecordingProvider();
    const metrics = new InMemoryMetricsStore();
    const handler = createWorkerHandler(makeDeps(provider, metrics));

    await handler(toDispatchEvent(event), "developer");

    expect(provider.calls).toEqual(["provision", "pushContext", "exec", "destroy"]);
    expect(metrics.getRecords()).toEqual([
      { taskType: "worker-env", iterations: 1, fixCycles: 0, status: "success" },
    ]);
  });

  it("throws for a disallowed repo so the Dispatcher can retry, and records the failure", async () => {
    const provider = new RecordingProvider();
    const metrics = new InMemoryMetricsStore();
    const handler = createWorkerHandler(makeDeps(provider, metrics, ["someone/else"]));

    await expect(handler(toDispatchEvent(event), "developer")).rejects.toThrow(/allow/i);

    expect(provider.calls).toEqual([]);
    expect(metrics.getRecords()[0]?.status).toBe("failure");
  });

  it("honours an injected buildTask", async () => {
    const provider = new RecordingProvider();
    let seenRunId = "";
    const handler = createWorkerHandler({
      ...makeDeps(provider),
      buildTask: (dispatched) => {
        seenRunId = dispatched.runId;
        return toWorkerTask({
          taskId: "t-9",
          repo: REPO,
          runtime: "python",
          command: "python main.py",
        });
      },
    });

    await handler(toDispatchEvent(event), "developer");

    expect(seenRunId).toBe("run-1");
  });
});

describe("worker env resolvers (#135 AC3)", () => {
  it("parses the allow-list, lowercasing and dropping blanks", () => {
    expect(
      resolveWorkerAllowedRepos({ DF_WORKER_ALLOWED_REPOS: "RicardoBlackSkye/Agent-Eve, ,x/y " }),
    ).toEqual([REPO, "x/y"]);
  });

  it("is fail-closed: unset means nothing may be provisioned", () => {
    expect(resolveWorkerAllowedRepos({})).toEqual([]);
  });

  it("defaults the runtime to node and refuses an unknown one by name", () => {
    expect(resolveWorkerRuntime({})).toBe("node");
    expect(resolveWorkerRuntime({ DF_WORKER_RUNTIME: "python" })).toBe("python");
    expect(() => resolveWorkerRuntime({ DF_WORKER_RUNTIME: "ruby" })).toThrow(/DF_WORKER_RUNTIME/);
  });

  it("defaults the credential TTL to 60 minutes and bounds it", () => {
    expect(resolveCredentialTtlSeconds({})).toBe(3600);
    expect(resolveCredentialTtlSeconds({ DF_CREDENTIAL_TTL_SECONDS: "600" })).toBe(600);
    expect(() => resolveCredentialTtlSeconds({ DF_CREDENTIAL_TTL_SECONDS: "7200" })).toThrow(
      /DF_CREDENTIAL_TTL_SECONDS/,
    );
    expect(() => resolveCredentialTtlSeconds({ DF_CREDENTIAL_TTL_SECONDS: "nope" })).toThrow(
      /DF_CREDENTIAL_TTL_SECONDS/,
    );
  });
});