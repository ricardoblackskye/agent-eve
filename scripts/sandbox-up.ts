/**
 * #553 AC3 — the one command that provisions the local sandbox AND proves it works.
 *
 * Before this, `df:sandbox-up` ran bootstrap.sh and then printed two instructions: "port-
 * forward this" and "run vault-proof.py". The operator had to run both by hand, so nothing
 * failed when the proof was skipped — "the sandbox works" was an unverified claim. ADR 0050
 * wants local runs provisioned deliberately: all prerequisites asserted in one place.
 *
 * This CLI wires the provisioning core to real process execution and the real vault proof.
 * It exits non-zero on any failure so a caller cannot mistake a refusal for success. The raw
 * shell deploy stays reachable as `npm run df:sandbox-up-shell` for debugging the executor.
 *
 * Usage:
 *   npm run df:sandbox-up                       # local minikube
 *   KUBE_CONTEXT=prod-east npm run df:sandbox-up   # an existing cluster (AC4)
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  provisionSandbox,
  type ExecFn,
  type ExecResult,
  type SandboxCluster,
} from "../agent/lib/dark-factory/sandbox-provisioning";

const execFileAsync = promisify(execFile);

const ROOT = resolve(__dirname, "..");

/**
 * Real exec: runs a native binary and normalises the result. Non-zero exits are RETURNED, not
 * thrown, so the core can report a refusal instead of a stack trace.
 */
const exec: ExecFn = async (command, args, options): Promise<ExecResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      env: options?.env ?? process.env,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

/** The cluster parameter: KUBE_CONTEXT selects an existing cluster (AC4). */
function resolveCluster(): SandboxCluster {
  const context = process.env.KUBE_CONTEXT;
  if (context) {
    return { context, kubeconfig: process.env.KUBE_KUBECONFIG };
  }
  return "minikube";
}

/** Reachability probe against the forwarded endpoint. */
async function reachSandbox(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000) });
    // Any HTTP answer means the control plane is listening; the vault proof checks behaviour.
    return response.status < 500;
  } catch {
    return false;
  }
}

/** Runs the real MITM substitution proof. Exit 0 is the only PASS. */
async function runVaultProof(endpoint: string): Promise<boolean> {
  const port = new URL(endpoint).port || "18082";
  const proofScript = join(ROOT, "scripts/k8s-vault-proof/vault-proof.py");
  if (!existsSync(proofScript)) return false;
  const result = await exec("python", [proofScript, "--port", port]);
  if (result.code !== 0) {
    process.stderr.write(result.stderr);
    return false;
  }
  process.stdout.write(result.stdout);
  return true;
}

async function main(): Promise<number> {
  const artifactsDir = join(ROOT, "scripts/sandbox-vendor");
  const forwardPort = Number(process.env.FORWARD_PORT ?? 18082);

  const result = await provisionSandbox({
    artifactsDir,
    workspaceDir: ROOT,
    cluster: resolveCluster(),
    forwardPort,
    exec,
    reachSandbox,
    runVaultProof,
  });

  if (!result.ok) {
    for (const problem of result.problems) {
      process.stderr.write(`ERROR: ${problem}\n`);
    }
    return 1;
  }

  process.stdout.write(`sandbox provisioned and proven at ${result.endpoint}\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
    if (code !== 0) process.exit(1);
  })
  .catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
