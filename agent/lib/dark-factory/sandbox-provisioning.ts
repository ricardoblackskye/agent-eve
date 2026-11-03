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
}

export interface ProvisionResult {
  ok: boolean;
  endpoint: string;
  problems: string[];
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

function fail(endpoint: string, problems: string[]): ProvisionResult {
  return { ok: false, endpoint, problems };
}

export async function provisionSandbox(
  options: ProvisionOptions,
): Promise<ProvisionResult> {
  const endpoint = `http://localhost:${options.forwardPort}`;
  const { exec } = options;

  // --- 1. the committed lock and a populated cache -------------------------
  const lockPath = join(options.artifactsDir, "artifacts.lock.json");
  if (!existsSync(lockPath)) {
    return fail(endpoint, [`the vendor lock is missing: ${lockPath}. ${VENDOR_HINT}`]);
  }

  let lock: Lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8")) as Lock;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(endpoint, [`the vendor lock is not valid JSON (${lockPath}): ${message}`]);
  }

  const cacheDir = join(options.artifactsDir, "cache");
  const cached = existsSync(cacheDir)
    ? readdirSync(cacheDir).filter((entry) => entry.endsWith(".tar"))
    : [];
  if (cached.length < lock.images.length) {
    // AC2/AC6: refuse, name the command, do not fetch.
    return fail(endpoint, [
      `the image cache is not populated (${cached.length} of ${lock.images.length} images in ${cacheDir}).`,
      `Nothing was deployed. ${VENDOR_HINT}`,
    ]);
  }

  // --- 2. every locked image is actually present locally ------------------
  for (const image of lock.images) {
    const inspected = await exec("docker", ["image", "inspect", image.ref]);
    if (inspected.code !== 0) {
      // AC6: naming the image is the actionable part.
      return fail(endpoint, [
        `image not present in the local store: ${image.ref}`,
        `Nothing was deployed. ${VENDOR_HINT}`,
      ]);
    }
  }

  // --- 3. cluster: one parameter, minikube or an existing context ---------
  const remote = typeof options.cluster === "string" ? undefined : options.cluster;
  const contextArgs: string[] = [];
  if (remote) {
    contextArgs.push("--kube-context", remote.context);
    if (remote.kubeconfig) contextArgs.push("--kubeconfig", remote.kubeconfig);
  } else {
    const status = await exec("minikube", ["status"]);
    if (status.code !== 0) {
      const started = await exec("minikube", ["start", "--driver=docker"]);
      if (started.code !== 0) {
        return fail(endpoint, ["minikube could not be started; see its output above."]);
      }
    }
  }

  // --- 4. deploy the committed chart --------------------------------------
  const chartPath = join(options.workspaceDir, lock.chart.path);
  if (!existsSync(chartPath)) {
    return fail(endpoint, [
      `the committed chart is missing: ${chartPath}. The checkout is incomplete.`,
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
    return fail(endpoint, ["helm upgrade --install failed; see its output above."]);
  }

  // --- 5. the proofs run HERE, not in the operator's other terminal -------
  let stopForward: (() => Promise<void>) | undefined;
  try {
    if (options.startForward) stopForward = await options.startForward();

    const reachable = await options.reachSandbox(endpoint);
    if (!reachable) {
      return fail(endpoint, [
        `the sandbox endpoint is not reachable at ${endpoint}.`,
        "The deploy completed but the control plane did not answer.",
      ]);
    }

    const proven = await options.runVaultProof(endpoint);
    if (!proven) {
      return fail(endpoint, [
        "the vault proof failed: credential substitution was not demonstrated.",
        "The control plane is up but its vault behaviour is unverified.",
      ]);
    }

    return { ok: true, endpoint, problems: [] };
  } finally {
    // A dangling port-forward outlives the command and holds the port, so teardown is
    // unconditional — success or failure.
    if (stopForward) await stopForward();
  }
}
