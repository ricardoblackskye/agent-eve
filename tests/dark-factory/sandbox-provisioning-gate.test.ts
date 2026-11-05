/**
 * #603 T4 (D1) - the provisioning core refuses before any mutation.
 *
 * D1 says a missing or mismatched binary must refuse early, named and with its fix, instead of
 * failing partway through a deploy. The gate at the top of `provisionSandbox` runs the same
 * `checkPrerequisites` as `df:sandbox-up --check`, so a refusal cannot slip into a half-built
 * cluster.
 *
 * These tests assert the negative case directly: when a binary is missing, provisionSandbox
 * returns prerequisites-missing AND never issues a single deploy command (minikube start,
 * helm dependency build, kubectl rollout, helm upgrade/install, kubectl port-forward).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { provisionSandbox } from "../../agent/lib/dark-factory/sandbox-provisioning";
import type { ExecFn, ExecResult } from "../../agent/lib/dark-factory/sandbox-provisioning";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const LOCK = {
  chart: { path: "vendor/opensandbox-charts/opensandbox", version: "1.2.0", source: "https://example.invalid" },
  crds: { path: "vendor/opensandbox-crds" },
  images: [
    { ref: "registry.example/opensandbox/execd:release-1.1.1", digest: `sha256:${"a".repeat(64)}` },
  ],
  binaries: [
    { name: "docker", versionConstraint: ">=20.10.0", required: true, acquiredBy: "operator", probe: { command: "docker", args: ["version"] }, fix: "Start Docker Desktop." },
    { name: "kubectl", versionConstraint: ">=1.28.0", required: true, acquiredBy: "operator", probe: { command: "kubectl", args: ["version", "--client"] }, fix: "Install kubectl." },
    { name: "helm", versionConstraint: ">=3.14.0", required: true, acquiredBy: "operator", probe: { command: "helm", args: ["version", "--short"] }, fix: "Install helm." },
    { name: "python", versionConstraint: ">=3.10.0", required: true, acquiredBy: "operator", probe: { command: "python", args: ["--version"] }, fix: "Install Python 3." },
    { name: "minikube", versionConstraint: ">=1.30.0", required: false, requiredFor: "minikube", acquiredBy: "operator", probe: { command: "minikube", args: ["version"] }, fix: "Install minikube." },
  ],
};

const PRESENT = (): ExecResult => ({ code: 0, stdout: "v99.99.99", stderr: "" });
const MISSING = (): ExecResult => ({ code: 1, stdout: "", stderr: "not found" });

interface Call {
  command: string;
  args: string[];
}

function makeFixture(binaries: unknown): { artifactsDir: string; workspaceDir: string } {
  const artifactsDir = mkdtempSync(join(tmpdir(), "df-gate-art-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "df-gate-ws-"));
  dirs.push(artifactsDir, workspaceDir);
  const cache = join(artifactsDir, "cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "image-0.tar"), "not a real image");
  writeFileSync(join(artifactsDir, "artifacts.lock.json"), JSON.stringify({ ...LOCK, binaries }));
  return { artifactsDir, workspaceDir };
}

/** Records every exec call; by default every binary is present and matching. */
function recordingExec(overrides: Record<string, ExecResult> = {}): { calls: Call[]; exec: ExecFn } {
  const calls: Call[] = [];
  const exec: ExecFn = async (command, args) => {
    calls.push({ command, args: [...args] });
    const key = [command, ...args].join(" ");
    for (const [match, result] of Object.entries(overrides)) {
      if (key.includes(match)) return result;
    }
    return PRESENT();
  };
  return { calls, exec };
}

/** Commands a deploy would issue, none of which may appear when the gate refuses. */
const DEPLOY_COMMANDS = ["minikube start", "helm dependency build", "kubectl rollout", "helm upgrade", "helm install", "kubectl port-forward"];

function deployCalls(calls: Call[]): string[] {
  return calls
    .map((call) => [call.command, ...call.args].join(" "))
    .filter((line) => DEPLOY_COMMANDS.some((verb) => line.includes(verb.split(" ")[0]) && line.includes(verb.split(" ")[1])));
}

describe("provisioning refuses before any mutation (#603 T4, D1)", () => {
  it("refuses with prerequisites-missing and issues no deploy command when a binary is absent", async () => {
    const { artifactsDir, workspaceDir } = makeFixture(LOCK.binaries);
    const { calls, exec } = recordingExec({ "helm version": MISSING() });

    const result = await provisionSandbox({
      artifactsDir,
      workspaceDir,
      cluster: "minikube",
      forwardPort: 18082,
      exec,
      reachSandbox: async () => false,
      runVaultProof: async () => false,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.code === "prerequisites-missing")).toBe(true);
    expect(result.problems.some((p) => p.code === "prerequisites-mismatch")).toBe(false);
    expect(deployCalls(calls)).toEqual([]);
  });

  it("refuses with prerequisites-mismatch (not deploy) when a binary is the wrong version", async () => {
    const { artifactsDir, workspaceDir } = makeFixture(LOCK.binaries);
    const { calls, exec } = recordingExec({ "helm version": { code: 0, stdout: "v2.0.0", stderr: "" } });

    const result = await provisionSandbox({
      artifactsDir,
      workspaceDir,
      cluster: "minikube",
      forwardPort: 18082,
      exec,
      reachSandbox: async () => false,
      runVaultProof: async () => false,
    });

    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.code === "prerequisites-mismatch")).toBe(true);
    expect(deployCalls(calls)).toEqual([]);
  });

  it("does not refuse at the gate when every binary is present and matching", async () => {
    const { artifactsDir, workspaceDir } = makeFixture(LOCK.binaries);
    const { exec } = recordingExec();

    const result = await provisionSandbox({
      artifactsDir,
      workspaceDir,
      cluster: "minikube",
      forwardPort: 18082,
      exec,
      reachSandbox: async () => false,
      runVaultProof: async () => false,
    });

    // The gate passed; whatever happens next is not a prerequisites refusal.
    expect(result.problems.some((p) => p.code === "prerequisites-missing" || p.code === "prerequisites-mismatch")).toBe(false);
  });
});
