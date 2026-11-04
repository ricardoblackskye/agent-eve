/**
 * #585 T4 (AC4) — the idempotent provisioning state file.
 *
 * The defect this closes: a second `df:sandbox-up` against an unchanged workspace re-ran
 * every stage even though nothing had changed. The fix is a JSON file recording, per stage,
 * the inputs that produced the last success. A stage is skipped only when its recorded
 * inputs still match reality.
 *
 * The dangerous half is invalidation: a stale skip must never masquerade as a successful
 * provision. So these tests pin both directions — a matching digest skips, a changed digest
 * does not — and the dependant cascade that makes a changed upstream force the downstream
 * stages to re-run.
 *
 * These are unit tests: temp directories only, no cluster, no Docker, no network.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canSkipStage,
  defaultStateFile,
  DEPENDENTS,
  digestOfFile,
  invalidateStage,
  invalidatedBy,
  loadState,
  recordStageSuccess,
  saveState,
  STATE_VERSION,
  STAGES,
  type SandboxState,
} from "../../agent/lib/dark-factory/sandbox-state";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "df-state-"));
  dirs.push(dir);
  return dir;
}

function emptyState(): SandboxState {
  return { version: STATE_VERSION, stages: {} };
}

describe("the state file location (#585 T4)", () => {
  it("defaults to .data/sandbox-provision-state.json under the workspace", () => {
    expect(defaultStateFile("C:/Dev/Eve/agent-eve")).toBe(
      join("C:/Dev/Eve/agent-eve", ".data", "sandbox-provision-state.json"),
    );
  });
});

describe("loading state (#585 T4)", () => {
  it("treats a missing file as 'never provisioned' rather than an error", () => {
    const stateFile = join(makeDir(), "missing.json");
    expect(loadState(stateFile)).toEqual(emptyState());
  });

  it("treats a malformed file as absent, because a corrupt skip cache must not block a provision", () => {
    const dir = makeDir();
    const stateFile = join(dir, "state.json");
    writeFileSync(stateFile, "{ this is not json");
    expect(loadState(stateFile)).toEqual(emptyState());
  });

  it("treats an unknown version as absent, so an older cache is discarded rather than misread", () => {
    const dir = makeDir();
    const stateFile = join(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify({ version: 99, stages: { vendor: {} } }));
    expect(loadState(stateFile)).toEqual(emptyState());
  });

  it("round-trips a saved state", async () => {
    const stateFile = join(makeDir(), ".data", "sandbox-provision-state.json");
    const state = recordStageSuccess(emptyState(), "vendor", { lockDigest: "sha256:abc" });
    await saveState(stateFile, state);
    expect(loadState(stateFile)).toEqual(state);
  });

  it("creates the .data directory on save", async () => {
    const dir = makeDir();
    const stateFile = join(dir, ".data", "sandbox-provision-state.json");
    await saveState(stateFile, emptyState());
    expect(readFileSync(stateFile, "utf8")).toContain(`"version": ${STATE_VERSION}`);
  });
});

describe("the skip decision (#585 T4)", () => {
  it("does not skip a stage that has never completed", () => {
    expect(canSkipStage(emptyState(), "vendor", { lockDigest: "sha256:abc" })).toBe(false);
  });

  it("skips a stage whose recorded inputs still match", () => {
    const state = recordStageSuccess(emptyState(), "vendor", { lockDigest: "sha256:abc" });
    expect(canSkipStage(state, "vendor", { lockDigest: "sha256:abc" })).toBe(true);
  });

  it("does not skip when a recorded input changed — the stale-skip guard", () => {
    const state = recordStageSuccess(emptyState(), "vendor", { lockDigest: "sha256:abc" });
    expect(canSkipStage(state, "vendor", { lockDigest: "sha256:def" })).toBe(false);
  });

  it("does not skip when an input is added or removed", () => {
    const state = recordStageSuccess(emptyState(), "forward", { port: 8080 });
    expect(canSkipStage(state, "forward", { port: 8080, context: "minikube" })).toBe(false);
  });

  it("ignores key order, so a re-serialised record still skips", () => {
    const state = recordStageSuccess(emptyState(), "cluster", { context: "minikube", driver: "docker" });
    expect(canSkipStage(state, "cluster", { driver: "docker", context: "minikube" })).toBe(true);
  });

  it("does not skip a stage recorded with a non-completed status", () => {
    const state: SandboxState = {
      version: STATE_VERSION,
      stages: { vendor: { status: "failed" as never, inputs: { lockDigest: "sha256:abc" }, timestamp: "" } },
    };
    expect(canSkipStage(state, "vendor", { lockDigest: "sha256:abc" })).toBe(false);
  });
});

describe("the dependant cascade (#585 T4)", () => {
  it("declares every stage as a key, so the cascade cannot silently miss one", () => {
    expect(Object.keys(DEPENDENTS).sort()).toEqual([...STAGES].sort());
  });

  it("walks the cascade transitively: a vendor change reaches every downstream stage", () => {
    expect(invalidatedBy("vendor").sort()).toEqual(["deploy", "forward", "proof"]);
  });

  it("leaves upstream stages out of a downstream change", () => {
    expect(invalidatedBy("proof")).toEqual([]);
    expect(invalidatedBy("forward")).toEqual(["proof"]);
    expect(invalidatedBy("deploy").sort()).toEqual(["forward", "proof"]);
  });

  it("does not repeat a stage reachable by two paths", () => {
    const affected = invalidatedBy("cluster");
    expect(affected.sort()).toEqual(["deploy", "forward", "proof"]);
    expect(new Set(affected).size).toBe(affected.length);
  });

  it("records a success without mutating the state passed in", () => {
    const before = emptyState();
    const after = recordStageSuccess(before, "vendor", { lockDigest: "sha256:abc" });
    expect(before.stages).toEqual({});
    expect(after.stages.vendor?.status).toBe("completed");
  });

  it("clears dependents when a stage succeeds against new inputs", () => {
    let state = recordStageSuccess(emptyState(), "vendor", { lockDigest: "sha256:abc" });
    state = recordStageSuccess(state, "deploy", { chartVersion: "1.1.1" });
    state = recordStageSuccess(state, "forward", { port: 8080 });
    state = recordStageSuccess(state, "proof", { endpoint: "http://127.0.0.1:8080" });

    // A new vendor digest means the deploy consumed different bits: it must re-run, and so
    // must everything downstream of it.
    state = recordStageSuccess(state, "vendor", { lockDigest: "sha256:def" });
    expect(state.stages.vendor?.status).toBe("completed");
    expect(state.stages.deploy).toBeUndefined();
    expect(state.stages.forward).toBeUndefined();
    expect(state.stages.proof).toBeUndefined();
  });

  it("invalidateStage clears the stage and its dependents", () => {
    let state = recordStageSuccess(emptyState(), "cluster", { context: "minikube" });
    state = recordStageSuccess(state, "deploy", { chartVersion: "1.1.1" });
    state = invalidateStage(state, "cluster");
    expect(state.stages.cluster).toBeUndefined();
    expect(state.stages.deploy).toBeUndefined();
  });

  it("a failed stage leaves upstream successes intact, so a re-run resumes from the failure", () => {
    let state = recordStageSuccess(emptyState(), "vendor", { lockDigest: "sha256:abc" });
    state = invalidateStage(state, "deploy");
    expect(state.stages.vendor?.status).toBe("completed");
    expect(state.stages.deploy).toBeUndefined();
  });
});

describe("digesting the lock file (#585 T4)", () => {
  it("produces a sha256-prefixed digest that changes when the bytes change", () => {
    const dir = makeDir();
    const lock = join(dir, "artifacts.lock.json");
    writeFileSync(lock, JSON.stringify({ chart: "1.1.1" }));
    const first = digestOfFile(lock);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);

    writeFileSync(lock, JSON.stringify({ chart: "1.1.2" }));
    expect(digestOfFile(lock)).not.toBe(first);
  });

  it("is stable across repeated reads of the same bytes", () => {
    const dir = makeDir();
    const lock = join(dir, "artifacts.lock.json");
    writeFileSync(lock, JSON.stringify({ chart: "1.1.1" }));
    expect(digestOfFile(lock)).toBe(digestOfFile(lock));
  });
});
