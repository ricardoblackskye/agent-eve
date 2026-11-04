/**
 * #585 T5 (AC5) - the read-only preflight check.
 *
 * The defect this closes: the only way to find out whether a sandbox run could work was to
 * START one. A missing helm or a stopped Docker daemon surfaced after minikube had already
 * been started and images inspected, and the operator learned about the second missing
 * prerequisite only after fixing the first. A `--check` mode answers "would this work?" and
 * mutates nothing.
 *
 * The hard requirement is the negative one: check mode must issue ONLY read-only probes. A
 * check that starts a cluster or runs an upgrade is not a check, and it would make a
 * "dry" run expensive and non-idempotent.
 *
 * These are unit tests over an injected exec: no Docker, no cluster, no network.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

interface Recorded {
  command: string;
  args: string[];
}

/** A workspace with the committed lock and an optionally populated cache. */
function makeArtifacts(options: { tars: number }): string {
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
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, exec };
}

const ok = (): ExecResult => ({ code: 0, stdout: "", stderr: "" });
const missing = (): ExecResult => ({ code: 1, stdout: "", stderr: "not found" });

/** Commands that would change state; a check must never issue one. */
const MUTATING = ["start", "upgrade", "install", "pull", "apply", "delete", "uninstall"];

function mutatingCalls(calls: Recorded[]): string[] {
  return calls
    .map((call) => [call.command, ...call.args].join(" "))
    .filter((line) => MUTATING.some((verb) => line.split(" ").includes(verb)));
}

describe("the read-only preflight check (#585 T5)", () => {
  it("passes when every prerequisite is present", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { calls, exec } = recorder();

    const result = await checkPrerequisites({
      artifactsDir,
      cluster: "minikube",
      exec,
    });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    // It probed, so it is not vacuous.
    expect(calls.length).toBeGreaterThan(0);
  });

  it("names a missing binary and reports prerequisites-missing", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { exec } = recorder({ "helm version": missing() });

    const result = await checkPrerequisites({
      artifactsDir,
      cluster: "minikube",
      exec,
    });

    expect(result.ok).toBe(false);
    expect(result.problems[0]?.code).toBe("prerequisites-missing");
    expect(result.problems[0]?.subject).toContain("helm");
    // The fix must tell the operator what to do, not just that something failed.
    expect(result.problems[0]?.fix.length).toBeGreaterThan(0);
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

    const result = await checkPrerequisites({
      artifactsDir,
      cluster: "minikube",
      exec,
    });

    expect(result.ok).toBe(false);
    const subjects = result.problems.map((problem) => problem.subject).join("\n");
    expect(subjects).toContain("helm");
    expect(subjects).toContain("kubectl");
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

    const result = await checkPrerequisites({
      artifactsDir,
      cluster: "minikube",
      exec,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.subject).join("\n")).toContain(
      "image cache is not populated",
    );
    expect(renderCheck(result.problems).join("\n")).toContain("df:sandbox-vendor");
  });

  it("names a locked image that is not in the local store", async () => {
    const artifactsDir = makeArtifacts({ tars: 2 });
    const { exec } = recorder({ "image inspect": missing() });

    const result = await checkPrerequisites({
      artifactsDir,
      cluster: "minikube",
      exec,
    });

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
});
