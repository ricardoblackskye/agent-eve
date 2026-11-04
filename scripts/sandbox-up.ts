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
import { checkPrerequisites, renderCheck } from "../agent/lib/dark-factory/sandbox-check";
import {
  parseFlags,
  renderFlagErrors,
  USAGE,
  USAGE_EXIT_CODE,
} from "../agent/lib/dark-factory/sandbox-flags";
import { exitCodeForProblem, exitCodeForResult } from "../agent/lib/dark-factory/sandbox-exit-codes";

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
  // #585 T6 (AC1/AC6): one parser owns the flags. Usage errors and secret refusal are caught
  // here, before anything runs, so a bad invocation cannot reach the mutating core. Exit 2 is
  // outside the provisioning table because a bad flag is not a provisioning failure.
  const { flags, errors } = parseFlags(process.argv.slice(2));

  // #585 T2: stdout is NDJSON only. Human prose goes to stderr, so a GUI or CI consumer
  // can read events line-wise without stripping text.
  const emit = createNdjsonEmitter({ write: (line) => process.stdout.write(line) });

  if (errors.length > 0) {
    for (const line of renderFlagErrors(errors)) {
      process.stderr.write(`ERROR: ${line}
`);
    }
    process.stderr.write(USAGE);
    emit({
      step: "done",
      phase: "failure",
      message: "invalid invocation",
      exitCode: USAGE_EXIT_CODE,
    });
    return USAGE_EXIT_CODE;
  }

  if (flags.help) {
    process.stderr.write(USAGE);
    return 0;
  }

  // Flags override the environment; the environment stays the fallback so existing invocations
  // (`KUBE_CONTEXT=prod-east npm run df:sandbox-up`) keep working unchanged.
  const artifactsDir = flags.artifactsDir ?? join(ROOT, "scripts/sandbox-vendor");
  const workspaceDir = flags.workspaceDir ?? ROOT;
  const forwardPort = flags.forwardPort ?? Number(process.env.FORWARD_PORT ?? 18082);
  const cluster = flags.cluster ?? resolveCluster();

  // #585 T5 (AC5): `--check` answers "would this work?" and mutates nothing. It runs the
  // read-only preflight and returns before the provisioning core, so a failing check cannot
  // start a cluster, pull an image or write the state file. Exit code 10 is the documented
  // "prerequisite missing" signal; artifact problems map to 11 via the same table.
  if (flags.check) {
    emit({ step: "check", phase: "start", message: "checking prerequisites" });
    const checked = await checkPrerequisites({
      artifactsDir,
      cluster,
      exec,
    });
    if (!checked.ok) {
      for (const line of renderCheck(checked.problems)) {
        process.stderr.write(`ERROR: ${line}\n`);
      }
      emit({ step: "check", phase: "failure", message: "prerequisites are not satisfied" });
      const code = exitCodeForProblem(checked.problems[0]?.code ?? "prerequisites-missing");
      emit({ step: "done", phase: "failure", message: "preflight refused", exitCode: code });
      return code;
    }
    emit({ step: "check", phase: "success", message: "prerequisites are satisfied" });
    process.stderr.write("prerequisites satisfied; nothing was changed\n");
    emit({ step: "done", phase: "success", message: "preflight passed", exitCode: 0 });
    return 0;
  }

  const result = await provisionSandbox({
    artifactsDir,
    workspaceDir,
    cluster,
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
    // Preserve the documented code. Collapsing every failure to 1 here would defeat the exit
    // table (#585 T3) and turn a usage error's 2 into a 1.
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
