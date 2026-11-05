/**
 * #585 T5 (AC5) + #603 T2 (D2/D3) - the read-only preflight check.
 *
 * The defect this closes: the only way to find out whether a sandbox run could work was to
 * START one. A missing helm or a stopped Docker daemon surfaced after minikube had already
 * been started and images inspected, and the operator learned about the second missing
 * prerequisite only after fixing the first. A `--check` mode answers "would this work?" and
 * mutates nothing.
 *
 * #603 D2/D3: the binary prerequisites are now manifest-driven. The check reads
 * scripts/sandbox-vendor/artifacts.lock.json, probes each required binary's version using the
 * probe command declared in the manifest, and refuses (prerequisites-missing when absent,
 * prerequisites-mismatch when present but wrong) before any state-changing stage runs.
 *
 * The hard requirement is the negative one: check mode must issue ONLY read-only probes. A
 * check that starts a cluster or runs an upgrade is not a check, and it would make a "dry" run
 * expensive and non-idempotent.
 *
 * These are unit tests over an injected exec: no Docker, no cluster, no network.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exitCodeForProblem } from "../../agent/lib/dark-factory/sandbox-exit-codes";
import { checkPrerequisites, renderCheck } from "../../agent/lib/dark-factory/sandbox-check";
import type { ExecFn, ExecResult } from "../../agent/lib/dark-factory/sandbox-provisioning";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const IMAGE_A = "registry.example/opensandbox/execd:release-1.1.1";
const IMAGE_B = "registry.example/opensandbox/egress:release-1.1.1";

/** A version that satisfies every >= constraint in the fixtures below. */
const PRESENT_VERSION = "v99.99.99";

interface Recorded {
  command: string;
  args: string[];
}

/** A workspace with the committed-shape lock (chart, crds, images AND binaries) and a cache. */
function makeArtifacts(options: { tars: number; helmDigest?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "df-check-"));
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
      binaries: [
        {
          name: "docker",
          versionConstraint: ">=20.10.0",
          required: true,
          acquiredBy: "operator",
          probe: { command: "docker", args: ["version", "--format", "{{.Server.Version}}"] },
          fix: "Start Docker Desktop.",
        },
        {
          name: "kubectl",
          versionConstraint: ">=1.28.0",
          required: true,
          acquiredBy: "operator",
          probe: { command: "kubectl", args: ["version", "--client"] },
          fix: "Install kubectl.",
        },
        {
          name: "helm",
          versionConstraint: ">=3.14.0",
          required: true,
          acquiredBy: "operator",
          probe: { command: "helm", args: ["version", "--short"] },
          fix: "Install helm.",
          ...(options.helmDigest ? { expectedDigest: options.helmDigest } : {}),
        },
        {
          name: "python",
          versionConstraint: ">=3.10.0",
          required: true,
          acquiredBy: "operator",
          probe: { command: "python", args: ["--version"] },
          fix: "Install Python 3.",
        },
        {
          name: "minikube",
          versionConstraint: ">=1.30.0",
          required: false,
          requiredFor: "minikube",
          acquiredBy: "operator",
          probe: { command: "minikube", args: ["version"] },
          fix: "Install minikube.",
        },
      ],
    }),
  );
  return dir;
}

function recorder(overrides: Record<string, ExecResult> = {}) {
  const calls: Recorded[] = [];
  const exec: ExecFn = async (command, args) => {
    calls.push({ command, args: [...args] });
    const key = [command, ...args].join(" ");
    for (const [match, result] of Object.entries(overrides)) {
      if (key.includes(match)) return result;
    }
    // Default: every binary is present at a version that satisfies the manifest.
    return { code: 0, stdout: PRESENT_VERSION, stderr: "" };
  };
  return { calls, exec };
}

const missing = (): ExecResult => ({ code: 1, stdout: "", stderr: "not found" });

/** Commands that would change state; a check must never issue one. */
const MUTATING = ["start", "upgrade", "install", "pull", "apply", "delete", "uninstall"];

function mutatingCalls(calls: Recorded[]): string[] {
  return calls
    .map((call) => [call.command, ...call.args].join(" "))
    .filter((line) => MUTATING.some((verb) => line.split(" ").includes(verb)));
}

describe("the read-only preflight check (#585 T5 / #603 T2)", () => {
  it("passes when every prerequisite is present and matching", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { calls, exec } = recorder();

    const result = await checkPrerequisites({ artifactsDir, cluster: "minikube", exec });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    // It probed, so it is not vacuous.
    expect(calls.length).toBeGreaterThan(0);
  });

  it("names a missing binary and reports prerequisites-missing (D1)", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { exec } = recorder({ "helm version": missing() });

    const result = await checkPrerequisites({ artifactsDir, cluster: "minikube", exec });

    expect(result.ok).toBe(false);
    const missingProblem = result.problems.find((p) => p.code === "prerequisites-missing");
    expect(missingProblem?.subject).toContain("helm");
    expect(missingProblem?.fix.length).toBeGreaterThan(0);
  });

  it("maps a missing prerequisite to exit code 10", () => {
    expect(exitCodeForProblem("prerequisites-missing")).toBe(10);
  });

  it("reports every missing prerequisite in one pass, not just the first", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { exec } = recorder({
      "helm version": missing(),
      "kubectl version": missing(),
    });

    const result = await checkPrerequisites({ artifactsDir, cluster: "minikube", exec });

    expect(result.ok).toBe(false);
    const subjects = result.problems.map((problem) => problem.subject).join("\n");
    expect(subjects).toContain("helm");
    expect(subjects).toContain("kubectl");
  });

  it("reports a version mismatch as prerequisites-mismatch (D3)", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    // helm is present but far too old for the manifest's >=3.14.0.
    const { exec } = recorder({ "helm version": { code: 0, stdout: "v2.0.0", stderr: "" } });

    const result = await checkPrerequisites({ artifactsDir, cluster: "minikube", exec });

    expect(result.ok).toBe(false);
    const mismatch = result.problems.find((p) => p.code === "prerequisites-mismatch");
    expect(mismatch).toBeDefined();
    expect(mismatch?.subject).toContain("helm");
    expect(mismatch?.subject).toContain("2.0.0");
    expect(mismatch?.subject).toContain(">=3.14.0");
  });

  it("refuses when the installed version cannot be parsed", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { exec } = recorder({ "helm version": { code: 0, stdout: "garbage", stderr: "" } });

    const result = await checkPrerequisites({ artifactsDir, cluster: "minikube", exec });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.code === "prerequisites-mismatch")).toBe(true);
  });

  it("maps a version mismatch to exit code 15", () => {
    expect(exitCodeForProblem("prerequisites-mismatch")).toBe(15);
  });

  // #603 T5 (D3): when a manifest entry records an expectedDigest, the actual binary file is
  // verified against it and a mismatch refuses before any mutating stage runs. Digest verification
  // is opt-in per entry - entries without expectedDigest are never read from disk.
  describe("binary digest verification (T5 / D3)", () => {
    it("refuses when the actual binary digest does not match the manifest", async () => {
      const artifactsDir = makeArtifacts({ tars: 2, helmDigest: "sha256:abc123" });
      const { exec } = recorder();
      const result = await checkPrerequisites({
        artifactsDir,
        cluster: "minikube",
        exec,
        resolveBinaryPath: async () => "C:/fake/helm.exe",
        digestOfFile: () => "sha256:deadbeef",
      });
      expect(result.ok).toBe(false);
      const mismatch = result.problems.find((p) => p.code === "prerequisites-mismatch");
      expect(mismatch?.subject).toContain("digest mismatch");
      expect(mismatch?.subject).toContain("helm");
    });

    it("accepts the binary when its digest matches the manifest", async () => {
      const artifactsDir = makeArtifacts({ tars: 2, helmDigest: "sha256:abc123" });
      const { exec } = recorder();
      const result = await checkPrerequisites({
        artifactsDir,
        cluster: "minikube",
        exec,
        resolveBinaryPath: async () => "C:/fake/helm.exe",
        digestOfFile: () => "sha256:abc123",
      });
      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
    });

    it("skips digest verification when the binary path cannot be resolved", async () => {
      const artifactsDir = makeArtifacts({ tars: 2, helmDigest: "sha256:abc123" });
      const { exec } = recorder();
      const result = await checkPrerequisites({
        artifactsDir,
        cluster: "minikube",
        exec,
        resolveBinaryPath: async () => null,
        digestOfFile: () => "sha256:deadbeef",
      });
      // No path -> nothing to compare against -> the (present, matching-version) binary passes.
      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([]);
    });
  });

  it("uses the probe command/args declared in the manifest (data-driven)", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { calls, exec } = recorder();

    await checkPrerequisites({ artifactsDir, cluster: "minikube", exec });

    const helmProbe = calls.find((c) => c.command === "helm");
    expect(helmProbe?.args).toEqual(["version", "--short"]);
    const dockerProbe = calls.find((c) => c.command === "docker");
    expect(dockerProbe?.args).toEqual(["version", "--format", "{{.Server.Version}}"]);
  });

  it("requires minikube for a local cluster but not for an existing one", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });

    const local = await checkPrerequisites({
      artifactsDir,
      cluster: "minikube",
      exec: recorder({ "minikube version": missing() }).exec,
    });
    expect(local.ok).toBe(false);
    expect(local.problems.map((problem) => problem.subject).join("\n")).toContain("minikube");

    const remote = await checkPrerequisites({
      artifactsDir,
      cluster: { context: "prod-east", kubeconfig: "C:/kube/config" },
      exec: recorder({ "minikube version": missing() }).exec,
    });
    // A remote context needs kubectl, not minikube.
    expect(remote.problems.map((problem) => problem.subject).join("\n")).not.toContain("minikube");
  });

  it("names the vendor command when the artifact cache is empty", async () => {
    const artifactsDir = makeArtifacts({ tars: 0 });
    const { exec } = recorder();

    const result = await checkPrerequisites({ artifactsDir, cluster: "minikube", exec });

    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.subject).join("\n")).toContain(
      "image cache is not populated",
    );
    expect(renderCheck(result.problems).join("\n")).toContain("df:sandbox-vendor");
  });

  it("names a locked image that is not in the local store", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { exec } = recorder({ "image inspect": missing() });

    const result = await checkPrerequisites({ artifactsDir, cluster: "minikube", exec });

    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.subject).join("\n")).toContain(IMAGE_A);
  });

  it("issues only read-only probes and mutates nothing", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { calls, exec } = recorder();

    await checkPrerequisites({ artifactsDir, cluster: "minikube", exec });

    expect(mutatingCalls(calls)).toEqual([]);
  });

  it("still issues only read-only probes when a prerequisite is missing", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { calls, exec } = recorder({ "docker version": missing() });

    await checkPrerequisites({ artifactsDir, cluster: "minikube", exec });

    expect(mutatingCalls(calls)).toEqual([]);
  });

  it("treats a missing artifact lock as a failure naming the vendor command", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    rmSync(join(artifactsDir, "artifacts.lock.json"));
    const { exec } = recorder();

    const result = await checkPrerequisites({ artifactsDir, cluster: "minikube", exec });

    expect(result.ok).toBe(false);
    expect(renderCheck(result.problems).join("\n")).toContain("df:sandbox-vendor");
  });

  it("refuses when the lock's binaries section is malformed (fail closed)", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    // Strip the binaries section so parseManifest throws.
    const lockPath = join(artifactsDir, "artifacts.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    delete lock.binaries;
    writeFileSync(lockPath, JSON.stringify(lock));

    const result = await checkPrerequisites({ artifactsDir, cluster: "minikube", exec: recorder().exec });

    expect(result.ok).toBe(false);
    expect(result.problems[0]?.code).toBe("artifact-unresolvable");
  });
});
