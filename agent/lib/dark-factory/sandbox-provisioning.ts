/**
 * #553 — provisioning core for the local OpenSandbox control plane.
 *
 * WHY THIS EXISTS: `bootstrap.sh` was the whole story — a shell script that cloned the chart
 * from GitHub, downloaded helm from get.helm.sh, and pulled images by floating tag on every
 * cold run. That meant a "reproducible" local sandbox needed three networks reachable at
 * install time, could silently install different bits than the previous run, and left the
 * operator to run the vault proof by hand afterwards. ADR 0050 wants local runs provisioned
 * deliberately: every prerequisite asserted in one place.
 *
 * So the verified shell deploy stays as the executor (rewriting the five non-obvious fixes
 * would be reckless), and this module owns the decisions in front of it: is the cache
 * populated, is each image actually present, which cluster are we targeting, and did the
 * proofs pass. Every process call goes through an injected `exec`, which is what makes the
 * refusals unit-testable without a cluster.
 *
 * Refusal over fetch is the core rule (AC2/AC6): when the cache is empty we name the vendor
 * command and stop. Falling back to a network fetch would reproduce exactly the
 * non-reproducibility this change exists to remove.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  noopEmitter,
  type ProvisionEventInput,
  type ProvisionStep,
} from "./sandbox-events";
import { exitCodeForProblem } from "./sandbox-exit-codes";
import {
  canSkipStage,
  defaultStateFile,
  digestOfFile,
  invalidateStage,
  loadState,
  recordStageSuccess,
  saveState,
  STAGES,
  type ProvisionStage,
  type SandboxState,
} from "./sandbox-state";
import { checkPrerequisites } from "./sandbox-check";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export type SandboxCluster = "minikube" | { context: string; kubeconfig?: string };

export interface ProvisionOptions {
  /** Directory holding artifacts.lock.json and cache/ (scripts/sandbox-vendor). */
  artifactsDir: string;
  workspaceDir: string;
  cluster: SandboxCluster;
  forwardPort: number;
  exec: ExecFn;
  reachSandbox: (endpoint: string) => Promise<boolean>;
  runVaultProof: (endpoint: string) => Promise<boolean>;
  /** Optional port-forward adapter; the default spawns kubectl port-forward. */
  startForward?: () => Promise<() => Promise<void>>;
  /**
   * #585 T2 (AC3): stage events for a caller that renders progress. Optional — a caller
   * that only wants the result passes nothing and gets the same behaviour as before.
   */
  onEvent?: (event: ProvisionEventInput) => void;
  /**
   * #585 T4 (AC4): the state file that records completed stages so a re-run can skip them.
   * Defaults to `.data/sandbox-provision-state.json` under workspaceDir.
   */
  stateFile?: string;
}

/**
 * Stable failure classes (#585 T1). A caller maps a code to a distinct exit code without
 * parsing prose — the gap that made a helm cache failure indistinguishable from a vault failure
 * on Windows, since both exited 1. Prose stays for operators via `renderProblems`.
 */
export type ProvisionProblemCode =
  | "prerequisites-missing"
  | "prerequisites-mismatch"
  | "artifact-unresolvable"
  | "cluster-unreachable"
  | "proof-failed"
  | "teardown-failed"
  | "internal";

export interface ProvisionProblem {
  /** Stable, so callers and tests never match on prose. */
  code: ProvisionProblemCode;
  /** What failed, in one line. Names the object, never a secret value. */
  subject: string;
  /** What to do about it, in one line. */
  fix: string;
}

export interface ProvisionResult {
  ok: boolean;
  endpoint: string;
  problems: ProvisionProblem[];
}

/**
 * Human-readable rendering of classified problems. Keeps the prose output callers already
 * print: the code is for machines, these lines are for operators.
 */
export function renderProblems(problems: ProvisionProblem[]): string[] {
  return problems.flatMap((problem) => [problem.subject, problem.fix]);
}

interface LockImage {
  ref: string;
  digest: string;
}
interface Lock {
  chart: { path: string; version: string; source: string };
  crds: { path: string };
  images: LockImage[];
}

const NS_CP = "opensandbox-system";
const VENDOR_HINT = "run: npm run df:sandbox-vendor";

function fail(endpoint: string, problems: ProvisionProblem[]): ProvisionResult {
  return { ok: false, endpoint, problems };
}

export async function provisionSandbox(
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const endpoint = `http://localhost:${options.forwardPort}`;
  const { exec } = options;
  const emit = options.onEvent ?? noopEmitter;
  const stateFile = options.stateFile ?? defaultStateFile(options.workspaceDir);
  let state: SandboxState = loadState(stateFile);
  const clusterContext =
    typeof options.cluster === "string" ? options.cluster : options.cluster.context;

  /**
   * The step that refused, or undefined on success. The `finally` block reads it to
   * emit the terminal `done` event AFTER teardown — a consumer that stops on `done`
   * must not miss the teardown that follows it.
   */
  let failedStep: ProvisionStep | undefined;
  let failedCode: ProvisionProblemCode | undefined;
  let stopForward: (() => Promise<void>) | undefined;

  const refuse = (
    step: ProvisionStep,
    message: string,
    problems: ProvisionProblem[],
  ): ProvisionResult => {
    failedStep = step;
    failedCode = problems[0]?.code;
    // A failure means this stage's previous success is no longer trustworthy, and neither
    // is anything downstream of it. The `finally` block persists the invalidated state.
    if ((STAGES as readonly string[]).includes(step)) {
      state = invalidateStage(state, step as ProvisionStage);
    }
    emit({ step, phase: "failure", message });
    return fail(endpoint, problems);
  };

  try {
    // --- 0. prerequisite gate (#603 T4, D1): refuse before any mutation -----------
    // A missing or mismatched binary must fail HERE - named, with its fix - instead of
    // partway through a deploy. This is the concrete fix for the epic's mid-deploy failure
    // mode: --check and real runs now share one verify path, so a refusal cannot slip past
    // the gate into a half-built cluster.
    emit({ step: "check", phase: "start", message: "checking prerequisites" });
    const preflightResult = await checkPrerequisites({
      artifactsDir: options.artifactsDir,
      cluster: options.cluster,
      exec,
    });
    if (!preflightResult.ok) {
      // Refuse through the shared path so the terminal `done` event also carries the failure
      // phase (failedStep is set), and "check" is not a real stage so nothing is invalidated.
      return refuse("check", "prerequisites are not satisfied", preflightResult.problems);
    }
    emit({ step: "check", phase: "success", message: "prerequisites are satisfied" });

    // --- 1. the committed lock and a populated cache -----------------------
    emit({ step: "vendor", phase: "start", message: "checking artifact cache" });
    const lockPath = join(options.artifactsDir, "artifacts.lock.json");
    if (!existsSync(lockPath)) {
      return refuse("vendor", "the vendor lock is missing", [
        {
          code: "artifact-unresolvable",
          subject: `the vendor lock is missing: ${lockPath}`,
          fix: VENDOR_HINT,
        },
      ]);
    }

    let lock: Lock;
    try {
      lock = JSON.parse(readFileSync(lockPath, "utf8")) as Lock;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return refuse("vendor", "the vendor lock is not valid JSON", [
        {
          code: "artifact-unresolvable",
          subject: `the vendor lock is not valid JSON (${lockPath})`,
          fix: message,
        },
      ]);
    }

    const lockDigest = digestOfFile(lockPath);
    const vendorInputs = { lockDigest };

    if (canSkipStage(state, "vendor", vendorInputs)) {
      emit({ step: "vendor", phase: "skip", message: "artifact cache already complete" });
    } else {
      const cacheDir = join(options.artifactsDir, "cache");
      const cached = existsSync(cacheDir)
        ? readdirSync(cacheDir).filter((entry) => entry.endsWith(".tar"))
        : [];
      if (cached.length < lock.images.length) {
        // AC2/AC6: refuse, name the command, do not fetch.
        return refuse("vendor", "the image cache is not populated", [
          {
            code: "artifact-unresolvable",
            subject: `the image cache is not populated (${cached.length} of ${lock.images.length} images in ${cacheDir})`,
            fix: `Nothing was deployed. ${VENDOR_HINT}`,
          },
        ]);
      }

      // --- 2. every locked image is actually present locally -----------------
      for (const image of lock.images) {
        const inspected = await exec("docker", ["image", "inspect", image.ref]);
        if (inspected.code !== 0) {
          // AC6: naming the image is the actionable part.
          return refuse("vendor", "image not present in the local store", [
            {
              code: "artifact-unresolvable",
              subject: `image not present in the local store: ${image.ref}`,
              fix: `Nothing was deployed. ${VENDOR_HINT}`,
            },
          ]);
        }
      }
      emit({ step: "vendor", phase: "success", message: "artifact cache complete" });
      state = recordStageSuccess(state, "vendor", vendorInputs);
    }

    // --- 3. cluster: one parameter, minikube or an existing context --------
    emit({ step: "cluster", phase: "start", message: "resolving cluster" });
    const remote = typeof options.cluster === "string" ? undefined : options.cluster;
    const contextArgs: string[] = [];
    if (remote) {
      contextArgs.push("--kube-context", remote.context);
      if (remote.kubeconfig) contextArgs.push("--kubeconfig", remote.kubeconfig);
    }
    const clusterInputs = { context: clusterContext };
    if (canSkipStage(state, "cluster", clusterInputs)) {
      emit({ step: "cluster", phase: "skip", message: "cluster already ready" });
    } else {
      if (!remote) {
        const status = await exec("minikube", ["status"]);
        if (status.code !== 0) {
          const started = await exec("minikube", ["start", "--driver=docker"]);
          if (started.code !== 0) {
            return refuse("cluster", "minikube could not be started", [
              {
                code: "cluster-unreachable",
                subject: "minikube could not be started",
                fix: "see its output above",
              },
            ]);
          }
        }
      }
      emit({ step: "cluster", phase: "success", message: "cluster ready" });
      state = recordStageSuccess(state, "cluster", clusterInputs);
    }

    // --- 4. deploy the committed chart -------------------------------------
    emit({ step: "deploy", phase: "start", message: "deploying the committed chart" });
    const deployInputs = { lockDigest, context: clusterContext };
    if (canSkipStage(state, "deploy", deployInputs)) {
      emit({ step: "deploy", phase: "skip", message: "chart already deployed and rolled out" });
    } else {
      const chartPath = join(options.workspaceDir, lock.chart.path);
      if (!existsSync(chartPath)) {
        return refuse("deploy", "the committed chart is missing", [
          {
            code: "artifact-unresolvable",
            subject: `the committed chart is missing: ${chartPath}`,
            fix: "The checkout is incomplete.",
          },
        ]);
      }

      // The chart declares its subcharts as file:// dependencies; helm needs `dependency build`
      // to resolve them into charts/ before `upgrade --install`, or it fails with "repo not found".
      // (bootstrap.sh does this too, but this core path runs instead of the shell.)
      const build = await exec("helm", ["dependency", "build", chartPath], { env: process.env });
      if (build.code !== 0) {
        return refuse("deploy", "helm dependency build failed", [
          {
            code: "artifact-unresolvable",
            subject: "helm dependency build failed; the vendored chart could not resolve its subcharts",
            fix: "Run: npm run df:sandbox-vendor",
          },
        ]);
      }

      const deploy = await exec(
        "helm",
        [
          "upgrade",
          "--install",
          "opensandbox",
          chartPath,
          "-n",
          NS_CP,
          "--create-namespace",
          ...contextArgs,
        ],
        { env: process.env },
      );
      if (deploy.code !== 0) {
        return refuse("deploy", "helm upgrade --install failed", [
          {
            code: "internal",
            subject: "helm upgrade --install failed",
            fix: "see its output above",
          },
        ]);
      }

      // The chart does a spec-driven rollout on upgrade; the server pod is not Ready the instant
      // helm returns. Wait for it (bounded) before probing, or the reachability check fires early.
      // This is the same wait bootstrap.sh runs — the core path replaces the shell but must keep it.
      for (const target of ["deployment/opensandbox-server", "deployment/opensandbox-controller-manager"]) {
        const wait = await exec("kubectl", ["rollout", "status", target, "-n", NS_CP, "--timeout=240s"]);
        if (wait.code !== 0) {
          return refuse("deploy", "the control plane did not become ready", [
            {
              code: "cluster-unreachable",
              subject: `the control plane did not become ready: ${target} timed out`,
              fix: wait.stderr.trim() || "check: kubectl -n opensandbox-system get pods",
            },
          ]);
        }
      }
      emit({ step: "deploy", phase: "success", message: "chart deployed and rolled out" });
      state = recordStageSuccess(state, "deploy", deployInputs);
    }

    // --- 5. the proofs run HERE, not in the operator's other terminal ------
    emit({ step: "forward", phase: "start", message: "starting port-forward" });
    const forwardInputs = { port: options.forwardPort, context: clusterContext };
    if (canSkipStage(state, "forward", forwardInputs)) {
      emit({ step: "forward", phase: "skip", message: "port-forward already listening" });
    } else {
      // A forwarding callback spawns a real process, so it can throw (no port, no binary).
      // Convert that into a refusal with an actionable message instead of letting the error
      // escape past the `done` event: a caller that only reads the result would otherwise
      // see an exception where every other failure is a structured refusal.
      try {
        if (options.startForward) stopForward = await options.startForward();
        emit({ step: "forward", phase: "success", message: "port-forward listening" });
        state = recordStageSuccess(state, "forward", forwardInputs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return refuse("forward", "the port-forward could not be started", [
          {
            code: "internal",
            subject: `the port-forward could not be started: ${message}`,
            fix: "Check that the port is free and that kubectl is on PATH.",
          },
        ]);
      }
    }

    emit({ step: "proof", phase: "start", message: "running reachability and vault proof" });
    const proofInputs = { endpoint };
    if (canSkipStage(state, "proof", proofInputs)) {
      emit({ step: "proof", phase: "skip", message: "reachability and vault proof already passed" });
    } else {
      // A probe can throw as well as return false; both mean "not proven".
      let reachable = false;
      try {
        reachable = await options.reachSandbox(endpoint);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return refuse("proof", "the sandbox endpoint could not be reached", [
          {
            code: "cluster-unreachable",
            subject: `the sandbox endpoint could not be reached at ${endpoint}: ${message}`,
            fix: "The deploy completed but the control plane did not answer.",
          },
        ]);
      }
      if (!reachable) {
        return refuse("proof", "the sandbox endpoint is not reachable", [
          {
            code: "cluster-unreachable",
            subject: `the sandbox endpoint is not reachable at ${endpoint}`,
            fix: "The deploy completed but the control plane did not answer.",
          },
        ]);
      }

      let proven = false;
      try {
        proven = await options.runVaultProof(endpoint);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return refuse("proof", "the vault proof could not be run", [
          {
            code: "proof-failed",
            subject: `the vault proof could not be run: ${message}`,
            fix: "The control plane is up but its vault behaviour is unverified.",
          },
        ]);
      }
      if (!proven) {
        return refuse("proof", "the vault proof failed", [
          {
            code: "proof-failed",
            subject: "the vault proof failed: credential substitution was not demonstrated",
            fix: "The control plane is up but its vault behaviour is unverified.",
          },
        ]);
      }
      emit({ step: "proof", phase: "success", message: "reachability and vault proof passed" });
      state = recordStageSuccess(state, "proof", proofInputs);
    }

    return { ok: true, endpoint, problems: [] };
  } finally {
    // A dangling port-forward outlives the command and holds the port, so teardown is
    // unconditional — success or failure. The terminal `done` event fires AFTER teardown
    // so a consumer that stops on `done` does not leak the forward process.
    if (stopForward) {
      emit({ step: "teardown", phase: "start", message: "stopping port-forward" });
      await stopForward();
      emit({ step: "teardown", phase: "success", message: "port-forward stopped" });
    }
    // Persist the state AFTER teardown, so a failed teardown is not recorded as a clean
    // resume point. A corrupt or unwritable file must not mask the provisioning result, so
    // a save failure is reported but does not change the outcome.
    try {
      await saveState(stateFile, state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ step: "teardown", phase: "failure", message: `could not save state: ${message}` });
    }
    emit({
      step: "done",
      phase: failedStep ? "failure" : "success",
      message: failedStep ? "provisioning refused" : "sandbox provisioned and proven",
      exitCode: failedCode ? exitCodeForProblem(failedCode) : 0,
    });
  }
}
