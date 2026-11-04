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
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  provisionSandbox,
  renderProblems,
  type ExecFn,
  type ExecResult,
  type SandboxCluster,
} from "../agent/lib/dark-factory/sandbox-provisioning";
import { createNdjsonEmitter } from "../agent/lib/dark-factory/sandbox-events";
import { exitCodeForResult } from "../agent/lib/dark-factory/sandbox-exit-codes";

const execFileAsync = promisify(execFile);

// The repo is ESM ("type": "module"), so __dirname does not exist here. This is the same
// idiom scripts/load-env.ts uses. Found by running the CLI for real: the unit tests never
// execute it, so they could not catch this.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Real exec: runs a native binary and normalises the result. Non-zero exits are RETURNED, not
 * thrown, so the core can report a refusal instead of a stack trace.
 *
 * Binary resolution honours env overrides (HELM/KUBECTL/MINIKUBE/DOCKER) so the operator can
 * point at installed binaries without them being on PATH. Found by running for real: the core
 * calls exec("helm", ...) but helm here lives only at the HELM env var.
 */
const BIN_ENV: Record<string, string | undefined> = {
  helm: process.env.HELM,
  kubectl: process.env.KUBECTL,
  minikube: process.env.MINIKUBE,
  docker: process.env.DOCKER,
};
const resolveBin = (command: string): string => BIN_ENV[command] ?? command;

const exec: ExecFn = async (command, args, options): Promise<ExecResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(resolveBin(command), args, {
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

/** Starts the port-forward as a detached process and waits for it to be listening. */
async function startForward(): Promise<() => Promise<void>> {
  const port = Number(process.env.FORWARD_PORT ?? 18082);
  const child = spawn(resolveBin("kubectl"), [
    "port-forward",
    "-n", "opensandbox-system",
    "svc/opensandbox-server",
    `${port}:80`,
  ], { stdio: "ignore", detached: true });
  child.unref();

  // Poll until the local port answers, or give up after 30s.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}`);
      if (res.status < 500) break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return async () => {
    if (child.pid === undefined) return;
    // process.kill(-pid) targets a POSIX process GROUP and throws on Windows, so the forward
    // would outlive the command and hold the port for the next run. taskkill /T kills the tree.
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        /* already gone */
      }
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  };
}

async function main(): Promise<number> {
  const artifactsDir = join(ROOT, "scripts/sandbox-vendor");
  const forwardPort = Number(process.env.FORWARD_PORT ?? 18082);

  // #585 T2: stdout is NDJSON only. Human prose goes to stderr, so a GUI or CI consumer
  // can read events line-wise without stripping text.
  const emit = createNdjsonEmitter({ write: (line) => process.stdout.write(line) });

  const result = await provisionSandbox({
    artifactsDir,
    workspaceDir: ROOT,
    cluster: resolveCluster(),
    forwardPort,
    exec,
    reachSandbox,
    runVaultProof,
    // Without this the core's `if (options.startForward)` is false, so it skips forwarding
    // entirely and probes a dead port. Found by running for real — the unit tests inject
    // their own startForward, so they never caught the omission.
    startForward,
    onEvent: emit,
  });

  if (!result.ok) {
    // #585 T1: problems are classified objects now. Render the prose lines so the operator
    // still gets the actionable text; the code is for the caller (#582) to branch on.
    for (const line of renderProblems(result.problems)) {
      process.stderr.write(`ERROR: ${line}\n`);
    }
    return exitCodeForResult(result);
  }

  process.stderr.write(`sandbox provisioned and proven at ${result.endpoint}\n`);
  return exitCodeForResult(result);
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
