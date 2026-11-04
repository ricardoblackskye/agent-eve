/**
 * #553 AC1/AC2/AC4/AC6 — the provisioning core refuses instead of fetching, honours a
 * remote cluster parameter, and runs the proofs itself.
 *
 * The behaviour this pins, in the order the plan states it:
 *   - AC2/AC6: an empty image cache REFUSES and names the vendor command. The old script
 *     silently cloned the chart and pulled images instead, so a run depended on three
 *     networks being reachable and could install different bits than the last run.
 *   - AC6: an image absent from the local store is refused BY NAME.
 *   - AC4: a `{ context }` cluster is passed through as --kube-context and does NOT start
 *     minikube, so the same core can target a remote cluster with one parameter.
 *   - AC3: the deploy, the reachability probe and the vault proof all run from the core,
 *     in that order, and a failed proof tears the port-forward down rather than leaving a
 *     dangling process behind.
 *
 * Every process call goes through an injected exec, so these are unit tests: no cluster, no
 * Docker, no network. The real exec is wired in by the CLI entry point.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  provisionSandbox,
  renderProblems,
  type ExecFn,
  type ExecResult,
} from "../../agent/lib/dark-factory/sandbox-provisioning";
import type { ProvisionEventInput } from "../../agent/lib/dark-factory/sandbox-events";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface Recorded {
  command: string;
  args: string[];
}

const IMAGE_A = "registry.example/opensandbox/execd:release-1.1.1";
const IMAGE_B = "registry.example/opensandbox/egress:release-1.1.1";

/** A workspace with the committed lock and an optionally populated cache. */
function makeArtifacts(options: { tars: number }): string {
  const dir = mkdtempSync(join(tmpdir(), "df-prov-"));
  dirs.push(dir);
  const cache = join(dir, "cache");
  mkdirSync(cache, { recursive: true });
  for (let index = 0; index < options.tars; index += 1) {
    writeFileSync(join(cache, `image-${index}.tar`), "not a real image");
  }
  writeFileSync(
    join(dir, "artifacts.lock.json"),
    JSON.stringify({
      chart: {
        path: "vendor/opensandbox-charts/opensandbox",
        version: "1.2.0",
        source: "https://example.invalid/OpenSandbox",
      },
      crds: { path: "vendor/opensandbox-crds" },
      images: [
        { ref: IMAGE_A, digest: `sha256:${"a".repeat(64)}` },
        { ref: IMAGE_B, digest: `sha256:${"b".repeat(64)}` },
      ],
    }),
  );
  return dir;
}

function recorder(overrides: Record<string, ExecResult> = {}) {
  const calls: Recorded[] = [];
  const exec: ExecFn = async (command, args) => {
    calls.push({ command, args: [...args] });
    // Join the FULL argument list: a subcommand pair like `image inspect` never appears in
    // command + args[0] alone, so the shorter key silently never matched and the test that
    // depends on it could not fail.
    const key = [command, ...args].join(" ");
    for (const [match, result] of Object.entries(overrides)) {
      if (key.includes(match)) return result;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

const ok = (): ExecResult => ({ code: 0, stdout: "", stderr: "" });

describe("the sandbox provisioning core (#553)", () => {
  it("refuses an empty image cache and names the vendor command (AC2/AC6)", async () => {
    const artifactsDir = makeArtifacts({ tars: 0 });
    const { calls, exec } = recorder();

    const result = await provisionSandbox({
      artifactsDir,
      workspaceDir: process.cwd(),
      stateFile: join(artifactsDir, "state.json"),
      cluster: "minikube",
      forwardPort: 18082,
      exec,
      reachSandbox: async () => true,
      runVaultProof: async () => true,
    });

    expect(result.ok).toBe(false);
    // The operator must be told exactly what to run, not left guessing.
    expect(renderProblems(result.problems).join("\n")).toContain("df:sandbox-vendor");
    // And it must NOT have gone on to deploy from an unpopulated cache.
    expect(calls.some((call) => call.args.join(" ").includes("upgrade"))).toBe(false);
  });

  it("refuses an image that is not in the local store, naming it (AC6)", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { exec } = recorder({
      "image inspect": { code: 1, stdout: "", stderr: "No such image" },
    });

    const result = await provisionSandbox({
      artifactsDir,
      workspaceDir: process.cwd(),
      stateFile: join(artifactsDir, "state.json"),
      cluster: "minikube",
      forwardPort: 18082,
      exec,
      reachSandbox: async () => true,
      runVaultProof: async () => true,
    });

    expect(result.ok).toBe(false);
    const problems = renderProblems(result.problems).join("\n");
    // Naming the image is the whole point: "something failed" is not actionable.
    expect(problems).toContain(IMAGE_A);
  });

  it("passes a remote context through and never starts minikube (AC4)", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { calls, exec } = recorder();

    await provisionSandbox({
      artifactsDir,
      workspaceDir: process.cwd(),
      stateFile: join(artifactsDir, "state.json"),
      cluster: { context: "prod-east", kubeconfig: "C:/kube/config" },
      forwardPort: 18082,
      exec,
      reachSandbox: async () => true,
      runVaultProof: async () => true,
    });

    const flat = calls.map((call) => [call.command, ...call.args].join(" "));
    expect(flat.some((line) => line.includes("--kube-context prod-east"))).toBe(true);
    expect(flat.some((line) => line.includes("--kubeconfig C:/kube/config"))).toBe(true);
    // The one parameter replaces the hardcoded minikube start.
    expect(flat.some((line) => line.includes("minikube start"))).toBe(false);
  });

  it("runs deploy, reachability probe and vault proof in order (AC3)", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { calls, exec } = recorder();
    const order: string[] = [];

    await provisionSandbox({
      artifactsDir,
      workspaceDir: process.cwd(),
      stateFile: join(artifactsDir, "state.json"),
      cluster: "minikube",
      forwardPort: 18082,
      exec: async (command, args, options) => {
        order.push(`${command} ${args[0] ?? ""}`.trim());
        return exec(command, args, options);
      },
      reachSandbox: async () => {
        order.push("reachSandbox");
        return true;
      },
      runVaultProof: async () => {
        order.push("runVaultProof");
        return true;
      },
    });

    const deployIndex = order.findIndex((entry) => entry.includes("upgrade"));
    expect(deployIndex).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("reachSandbox")).toBeGreaterThan(deployIndex);
    expect(order.indexOf("runVaultProof")).toBeGreaterThan(order.indexOf("reachSandbox"));
    expect(calls.length).toBeGreaterThan(0);
  });

  it("tears the port-forward down and reports failure when the vault proof fails (AC3)", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { calls, exec } = recorder();
    const stops: string[] = [];

    const result = await provisionSandbox({
      artifactsDir,
      workspaceDir: process.cwd(),
      stateFile: join(artifactsDir, "state.json"),
      cluster: "minikube",
      forwardPort: 18082,
      exec,
      reachSandbox: async () => true,
      runVaultProof: async () => false,
      startForward: async () => async () => {
        stops.push("stopped");
      },
    });

    expect(result.ok).toBe(false);
    expect(renderProblems(result.problems).join("\n")).toContain("vault proof");
    // A dangling port-forward is the failure mode this catches.
    expect(stops.length).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
    expect(ok().code).toBe(0);
  });
});

/**
 * #585 T4 (AC4) - the resume behaviour.
 *
 * The point of the state file is that a second run against an unchanged workspace does not
 * redo the work. The dangerous half is invalidation: a stage whose inputs changed must NOT be
 * skipped, or a run reports "already provisioned" against bits that were never deployed.
 *
 * These tests drive the real core with a fake exec and a temp state file per case, so they
 * assert the wiring end to end rather than the state module in isolation.
 */
describe("resume and invalidation (#585 T4)", () => {
  interface Harness {
    artifactsDir: string;
    stateFile: string;
    events: ProvisionEventInput[];
    calls: Recorded[];
    forwardStarts: number;
    forwardStops: number;
    reachCalls: number;
    proofCalls: number;
    exec: ExecFn;
    reach: () => Promise<boolean>;
    proof: () => Promise<boolean>;
  }

  /**
   * A fresh workspace plus the options a healthy run needs. Callbacks are counted so a test
   * can prove a skipped stage did not touch them.
   */
  function harness(
    overrides: { reach?: () => Promise<boolean>; proof?: () => Promise<boolean> } = {},
  ): Harness {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { calls, exec } = recorder();
    const state = {
      artifactsDir,
      stateFile: join(artifactsDir, "state.json"),
      events: [] as ProvisionEventInput[],
      calls,
      forwardStarts: 0,
      forwardStops: 0,
      reachCalls: 0,
      proofCalls: 0,
      exec,
      reach: async () => true,
      proof: async () => true,
    } as Harness;
    state.reach = async () => {
      state.reachCalls += 1;
      return overrides.reach ? overrides.reach() : true;
    };
    state.proof = async () => {
      state.proofCalls += 1;
      return overrides.proof ? overrides.proof() : true;
    };
    return state;
  }

  function optionsFor(state: Harness) {
    return {
      artifactsDir: state.artifactsDir,
      workspaceDir: process.cwd(),
      stateFile: state.stateFile,
      cluster: "minikube" as const,
      forwardPort: 18082,
      exec: state.exec,
      reachSandbox: state.reach,
      runVaultProof: state.proof,
      startForward: async () => {
        state.forwardStarts += 1;
        return async () => {
          state.forwardStops += 1;
        };
      },
      onEvent: (event: ProvisionEventInput) => state.events.push(event),
    };
  }

  const stepsSkipped = (events: ProvisionEventInput[]): string[] =>
    events.filter((event) => event.phase === "skip").map((event) => event.step);

  const readSavedState = (stateFile: string) =>
    JSON.parse(readFileSync(stateFile, "utf8")) as {
      version: number;
      stages: Record<string, { status: string; inputs: Record<string, unknown> }>;
    };

  it("runs every stage end to end on a clean workspace (happy path)", async () => {
    const state = harness();
    const result = await provisionSandbox(optionsFor(state));

    expect(result.ok).toBe(true);
    expect(stepsSkipped(state.events)).toEqual([]);
    for (const step of ["vendor", "cluster", "deploy", "forward", "proof"]) {
      expect(
        state.events.some((event) => event.step === step && event.phase === "success"),
      ).toBe(true);
    }
    const done = state.events.at(-1) as ProvisionEventInput;
    expect(done.step).toBe("done");
    expect(done.phase).toBe("success");
    expect(done.exitCode).toBe(0);
  });

  it("skips the forward stage on a second run with matching inputs", async () => {
    const state = harness();
    const options = optionsFor(state);

    await provisionSandbox(options);
    expect(state.forwardStarts).toBe(1);

    state.events.length = 0;
    const second = await provisionSandbox(options);

    expect(second.ok).toBe(true);
    expect(stepsSkipped(state.events)).toContain("forward");
    expect(state.forwardStarts).toBe(1);
  });

  it("skips the proof stage on a second run with matching inputs", async () => {
    const state = harness();
    const options = optionsFor(state);

    await provisionSandbox(options);
    expect(state.proofCalls).toBe(1);

    state.events.length = 0;
    const second = await provisionSandbox(options);

    expect(second.ok).toBe(true);
    expect(stepsSkipped(state.events)).toContain("proof");
    expect(state.proofCalls).toBe(1);
    expect(state.reachCalls).toBe(1);
  });

  it("does not skip a single stage when nothing completed", async () => {
    const state = harness();
    const artifactsDir = makeArtifacts({ tars: 0 });
    const result = await provisionSandbox({
      ...optionsFor(state),
      artifactsDir,
      stateFile: join(artifactsDir, "state.json"),
    });

    expect(result.ok).toBe(false);
    expect(stepsSkipped(state.events)).toEqual([]);
  });

  it("refuses and logs when the port-forward cannot start", async () => {
    const state = harness();
    const result = await provisionSandbox({
      ...optionsFor(state),
      startForward: async () => {
        throw new Error("port 18082 already in use");
      },
    });

    expect(result.ok).toBe(false);
    expect(renderProblems(result.problems).join("\n")).toContain("port-forward");
    const failure = state.events.find(
      (event) => event.step === "forward" && event.phase === "failure",
    );
    expect(failure).toBeDefined();
    const done = state.events.at(-1) as ProvisionEventInput;
    expect(done.step).toBe("done");
    expect(done.phase).toBe("failure");
    expect(done.exitCode).toBe(1);
  });

  it("refuses and logs when the reachability probe throws", async () => {
    const state = harness({
      reach: async () => {
        throw new Error("connection refused");
      },
    });
    const result = await provisionSandbox(optionsFor(state));

    expect(result.ok).toBe(false);
    expect(renderProblems(result.problems).join("\n")).toContain("could not be reached");
    const failure = state.events.find(
      (event) => event.step === "proof" && event.phase === "failure",
    );
    expect(failure).toBeDefined();
    expect(state.events.at(-1)?.phase).toBe("failure");
  });

  it("refuses and logs when the vault proof returns false", async () => {
    const state = harness({ proof: async () => false });
    const result = await provisionSandbox(optionsFor(state));

    expect(result.ok).toBe(false);
    expect(renderProblems(result.problems).join("\n")).toContain("vault proof");
    const failure = state.events.find(
      (event) => event.step === "proof" && event.phase === "failure",
    );
    expect(failure).toBeDefined();
    expect(state.events.at(-1)?.phase).toBe("failure");
  });

  it("refuses and logs when the vault proof throws", async () => {
    const state = harness({
      proof: async () => {
        throw new Error("vault sealed");
      },
    });
    const result = await provisionSandbox(optionsFor(state));

    expect(result.ok).toBe(false);
    expect(renderProblems(result.problems).join("\n")).toContain("vault proof");
    expect(state.events.at(-1)?.phase).toBe("failure");
  });

  it("tears the port-forward down and saves state on a successful run", async () => {
    const state = harness();
    const result = await provisionSandbox(optionsFor(state));

    expect(result.ok).toBe(true);
    expect(state.forwardStops).toBe(1);
    const saved = readSavedState(state.stateFile);
    expect(Object.keys(saved.stages).sort()).toEqual([
      "cluster",
      "deploy",
      "forward",
      "proof",
      "vendor",
    ]);
    for (const stage of Object.values(saved.stages)) {
      expect(stage.status).toBe("completed");
    }
  });

  it("saves state on failure too, so a re-run resumes from the failed stage", async () => {
    const state = harness({ proof: async () => false });
    const result = await provisionSandbox(optionsFor(state));

    expect(result.ok).toBe(false);
    const saved = readSavedState(state.stateFile);
    for (const stage of ["vendor", "cluster", "deploy", "forward"]) {
      expect(saved.stages[stage]?.status).toBe("completed");
    }
    expect(saved.stages.proof).toBeUndefined();
  });

  it("invalidates vendor and everything downstream when the lock digest changes", async () => {
    const state = harness();
    const options = optionsFor(state);

    await provisionSandbox(options);
    const before = readSavedState(state.stateFile);
    expect(Object.keys(before.stages).sort()).toEqual([
      "cluster",
      "deploy",
      "forward",
      "proof",
      "vendor",
    ]);

    const lockPath = join(state.artifactsDir, "artifacts.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    const chart = lock.chart as Record<string, unknown>;
    chart.version = "9.9.9";
    writeFileSync(lockPath, JSON.stringify(lock));

    state.events.length = 0;
    state.forwardStarts = 0;
    state.proofCalls = 0;
    const second = await provisionSandbox(options);

    expect(second.ok).toBe(true);
    expect(stepsSkipped(state.events)).not.toContain("vendor");
    expect(
      state.events.some((event) => event.step === "vendor" && event.phase === "success"),
    ).toBe(true);
    expect(state.forwardStarts).toBe(1);
    expect(state.proofCalls).toBe(1);
  });

  it("skips all five stages on a repeat run after a full success (exhaustive)", async () => {
    const state = harness();
    const options = optionsFor(state);

    const first = await provisionSandbox(options);
    expect(first.ok).toBe(true);
    expect(state.calls.length).toBeGreaterThan(0);

    state.events.length = 0;
    state.calls.length = 0;
    state.forwardStarts = 0;
    state.forwardStops = 0;
    state.reachCalls = 0;
    state.proofCalls = 0;

    const second = await provisionSandbox(options);

    expect(second.ok).toBe(true);
    expect(stepsSkipped(state.events).sort()).toEqual([
      "cluster",
      "deploy",
      "forward",
      "proof",
      "vendor",
    ]);
    expect(state.calls).toEqual([]);
    expect(state.forwardStarts).toBe(0);
    expect(state.reachCalls).toBe(0);
    expect(state.proofCalls).toBe(0);
    expect(state.forwardStops).toBe(0);
    const done = state.events.at(-1) as ProvisionEventInput;
    expect(done.step).toBe("done");
    expect(done.phase).toBe("success");
    expect(done.exitCode).toBe(0);
  });
});
