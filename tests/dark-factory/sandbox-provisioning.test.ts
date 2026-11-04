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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  provisionSandbox,
  renderProblems,
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
