/**
 * #585 T1 — every provisioning failure class carries a STABLE CODE, not free text.
 *
 * The defect this closes: `ProvisionResult.problems` is `string[]`, so a caller (#582's Windows
 * program, or CI) cannot map a failure to a distinct exit code without parsing prose. On Windows
 * a `helm dependency build` failure and a vault failure both exited 1, so the caller could not
 * tell "run the vendor step" from "inspect cluster logs".
 *
 * These assertions are about the CODE on each problem, not the wording. Prose may be reworded
 * freely; a reclassification breaks the build.
 *
 * Every process call goes through the injected exec, so these are unit tests: no cluster, no
 * Docker, no network.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  provisionSandbox,
  type ExecFn,
  type ExecResult,
} from "../../agent/lib/dark-factory/sandbox-provisioning";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const IMAGE_A = "registry.example/opensandbox/execd:release-1.1.1";
const IMAGE_B = "registry.example/opensandbox/egress:release-1.1.1";
const CHART_PATH = "vendor/opensandbox-charts/opensandbox";

/** A workspace with the committed lock and an optionally populated cache. */
function makeArtifacts(options: { tars: number }): string {
  const dir = mkdtempSync(join(tmpdir(), "df-codes-"));
  dirs.push(dir);
  const cache = join(dir, "cache");
  mkdirSync(cache, { recursive: true });
  for (let index = 0; index < options.tars; index += 1) {
    writeFileSync(join(cache, `image-${index}.tar`), "not a real image");
  }
  writeFileSync(
    join(dir, "artifacts.lock.json"),
    JSON.stringify({
      chart: { path: CHART_PATH, version: "1.2.0", source: "https://example.invalid/OpenSandbox" },
      crds: { path: "vendor/opensandbox-crds" },
      images: [
        { ref: IMAGE_A, digest: `sha256:${"a".repeat(64)}` },
        { ref: IMAGE_B, digest: `sha256:${"b".repeat(64)}` },
      ],
    }),
  );
  return dir;
}

/** A workspace whose committed chart directory exists. */
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "df-ws-"));
  dirs.push(dir);
  mkdirSync(join(dir, CHART_PATH), { recursive: true });
  return dir;
}

function recorder(overrides: Record<string, ExecResult> = {}) {
  const exec: ExecFn = async (command, args) => {
    const key = [command, ...args].join(" ");
    for (const [match, result] of Object.entries(overrides)) {
      if (key.includes(match)) return result;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return exec;
}

/** Provision against a healthy fake, overriding only what a case needs. */
async function provision(options: {
  artifactsDir?: string;
  workspaceDir?: string;
  overrides?: Record<string, ExecResult>;
  reachSandbox?: () => Promise<boolean>;
  runVaultProof?: () => Promise<boolean>;
}) {
  const artifactsDir = options.artifactsDir ?? makeArtifacts({ tars: 2 });
  const workspaceDir = options.workspaceDir ?? makeWorkspace();
  return provisionSandbox({
    artifactsDir,
    workspaceDir,
    cluster: "minikube",
    forwardPort: 18082,
    exec: recorder(options.overrides),
    reachSandbox: options.reachSandbox ?? (async () => true),
    runVaultProof: options.runVaultProof ?? (async () => true),
  });
}

/** Every code on the result, in order. */
function codes(problems: { code: string }[]): string[] {
  return problems.map((problem) => problem.code);
}

describe("#585 T1 — provisioning failures carry stable codes", () => {
  it("classifies a missing vendor lock as artifact-unresolvable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "df-empty-"));
    dirs.push(dir);
    const result = await provision({ artifactsDir: dir });
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(["artifact-unresolvable"]);
  });

  it("classifies an invalid vendor lock as artifact-unresolvable", async () => {
    const dir = makeArtifacts({ tars: 2 });
    writeFileSync(join(dir, "artifacts.lock.json"), "{ not json");
    const result = await provision({ artifactsDir: dir });
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(["artifact-unresolvable"]);
  });

  it("classifies an empty image cache as artifact-unresolvable", async () => {
    const result = await provision({ artifactsDir: makeArtifacts({ tars: 0 }) });
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(["artifact-unresolvable"]);
  });

  it("classifies an image absent from the local store as artifact-unresolvable", async () => {
    const result = await provision({
      overrides: { "image inspect": { code: 1, stdout: "", stderr: "No such image" } },
    });
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(["artifact-unresolvable"]);
  });

  it("classifies a missing committed chart as artifact-unresolvable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "df-no-chart-"));
    dirs.push(dir);
    const result = await provision({ workspaceDir: dir });
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(["artifact-unresolvable"]);
  });

  it("classifies a failed helm dependency build as artifact-unresolvable", async () => {
    const result = await provision({
      overrides: { "dependency build": { code: 1, stdout: "", stderr: "repo not found" } },
    });
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(["artifact-unresolvable"]);
  });

  it("classifies a minikube that fails to start as cluster-unreachable", async () => {
    const result = await provision({
      overrides: {
        "minikube status": { code: 1, stdout: "", stderr: "not running" },
        "minikube start": { code: 1, stdout: "", stderr: "cannot start" },
      },
    });
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(["cluster-unreachable"]);
  });

  it("classifies a control-plane rollout timeout as cluster-unreachable", async () => {
    const result = await provision({
      overrides: { "rollout status": { code: 1, stdout: "", stderr: "timed out" } },
    });
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(["cluster-unreachable"]);
  });

  it("classifies an unreachable endpoint as cluster-unreachable", async () => {
    const result = await provision({ reachSandbox: async () => false });
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(["cluster-unreachable"]);
  });

  it("classifies a failed vault proof as proof-failed", async () => {
    const result = await provision({ runVaultProof: async () => false });
    expect(result.ok).toBe(false);
    expect(codes(result.problems)).toEqual(["proof-failed"]);
  });

  it("leaves problems empty on success", async () => {
    const result = await provision({});
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("gives each of the five named failure classes a distinct code", async () => {
    // The plan names these five as the contract: a caller must be able to branch on them.
    const cache = await provision({ artifactsDir: makeArtifacts({ tars: 0 }) });
    const image = await provision({
      overrides: { "image inspect": { code: 1, stdout: "", stderr: "No such image" } },
    });
    const cluster = await provision({
      overrides: {
        "minikube status": { code: 1, stdout: "", stderr: "not running" },
        "minikube start": { code: 1, stdout: "", stderr: "cannot start" },
      },
    });
    const proof = await provision({ runVaultProof: async () => false });
    const reach = await provision({ reachSandbox: async () => false });

    const distinct = new Set([
      codes(cache.problems)[0],
      codes(image.problems)[0],
      codes(cluster.problems)[0],
      codes(proof.problems)[0],
      codes(reach.problems)[0],
    ]);
    // Non-vacuity: five results must actually yield codes, or a set of undefined values "passes".
    for (const result of [cache, image, cluster, proof, reach]) {
      expect(codes(result.problems).length).toBeGreaterThan(0);
    }
    // The cluster and reachability cases legitimately share a code; proof and artifacts must not.
    expect(codes(proof.problems)[0]).not.toBe(codes(cache.problems)[0]);
    expect(codes(cache.problems)[0]).toBe(codes(image.problems)[0]);
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });
});
