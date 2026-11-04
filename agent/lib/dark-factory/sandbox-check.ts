/**
 * #585 T5 (AC5) - the read-only preflight check.
 *
 * WHY THIS EXISTS: the only way to learn whether a sandbox run could work was to start one.
 * A missing helm or a stopped Docker daemon surfaced only after minikube had already been
 * started, and the operator discovered the second missing prerequisite only after fixing the
 * first. `--check` answers "would this work?" up front and mutates nothing.
 *
 * THE RULE THAT MATTERS: this module issues READ-ONLY probes only. It never starts a cluster,
 * runs an upgrade, pulls an image or writes the state file. A check that mutates is not a
 * check - it makes a "dry" run expensive and non-idempotent, and it would defeat the point of
 * asking first. Every command below is a version query or an inspect.
 *
 * It deliberately duplicates a few reads from the provisioning core rather than calling it:
 * the core's job is to change the world, so reusing it here would drag the mutations in. The
 * duplicate is two version probes and one cache count, and the shared types keep the two
 * honest.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ExecFn,
  ProvisionProblem,
  SandboxCluster,
} from "./sandbox-provisioning";

export interface CheckOptions {
  /** Directory holding artifacts.lock.json and cache/ (scripts/sandbox-vendor). */
  artifactsDir: string;
  /** The cluster target. A local target needs minikube; an existing one does not. */
  cluster: SandboxCluster;
  /** Injected so the checks stay testable without Docker, a cluster or a network. */
  exec: ExecFn;
}

export interface CheckResult {
  ok: boolean;
  problems: ProvisionProblem[];
}

const VENDOR_HINT = "run: npm run df:sandbox-vendor";

interface LockImage {
  ref: string;
  digest: string;
}
interface Lock {
  chart: { path: string; version: string; source: string };
  crds: { path: string };
  images: LockImage[];
}

/** A binary probe and the advice to give when it fails. */
interface BinaryCheck {
  command: string;
  args: string[];
  /** How the operator should recognise this prerequisite in the message. */
  label: string;
  fix: string;
}

/**
 * The prerequisites, each probed with a read-only command. Version queries only: none of
 * these starts, installs or pulls anything.
 */
function binaryChecks(cluster: SandboxCluster): BinaryCheck[] {
  const checks: BinaryCheck[] = [
    {
      command: "docker",
      args: ["version", "--format", "{{.Server.Version}}"],
      label: "docker",
      fix: "Start Docker Desktop (the daemon must be running, not just installed).",
    },
    {
      command: "kubectl",
      args: ["version", "--client"],
      label: "kubectl",
      fix: "Install kubectl and put it on PATH, or set KUBECTL to its full path.",
    },
    {
      command: "helm",
      args: ["version", "--short"],
      label: "helm",
      fix: "Install helm and put it on PATH, or set HELM to its full path.",
    },
    {
      command: "python",
      args: ["--version"],
      label: "python",
      fix: "Install Python 3; the vault proof runs scripts/k8s-vault-proof/vault-proof.py.",
    },
  ];

  // A remote context targets an existing cluster, so minikube is irrelevant there. Asking for
  // it would refuse a perfectly valid remote run.
  if (cluster === "minikube") {
    checks.push({
      command: "minikube",
      args: ["version"],
      label: "minikube",
      fix: "Install minikube and put it on PATH, or set MINIKUBE to its full path.",
    });
  }

  return checks;
}

/**
 * Probe every prerequisite and collect ALL failures in one pass. Reporting one at a time makes
 * the operator loop over installs; the whole point of a preflight is one answer.
 */
export async function checkPrerequisites(options: CheckOptions): Promise<CheckResult> {
  const problems: ProvisionProblem[] = [];

  for (const check of binaryChecks(options.cluster)) {
    const result = await options.exec(check.command, check.args);
    if (result.code !== 0) {
      problems.push({
        code: "prerequisites-missing",
        subject: `missing prerequisite: ${check.label} is not usable`,
        fix: check.fix,
      });
    }
  }

  const lockPath = join(options.artifactsDir, "artifacts.lock.json");
  if (!existsSync(lockPath)) {
    problems.push({
      code: "artifact-unresolvable",
      subject: `the vendor lock is missing: ${lockPath}`,
      fix: `Nothing is deployed. ${VENDOR_HINT}`,
    });
    return { ok: problems.length === 0, problems };
  }

  let lock: Lock;
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8")) as Lock;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push({
      code: "artifact-unresolvable",
      subject: `the vendor lock is not valid JSON (${lockPath})`,
      fix: message,
    });
    return { ok: problems.length === 0, problems };
  }

  const cacheDir = join(options.artifactsDir, "cache");
  const cached = existsSync(cacheDir)
    ? readdirSync(cacheDir).filter((entry) => entry.endsWith(".tar"))
    : [];
  if (cached.length < lock.images.length) {
    problems.push({
      code: "artifact-unresolvable",
      subject: `the image cache is not populated (${cached.length} of ${lock.images.length} images in ${cacheDir})`,
      fix: `Nothing is deployed. ${VENDOR_HINT}`,
    });
  }

  // Read-only: inspect only. A missing image is named so the operator knows which one.
  for (const image of lock.images) {
    const inspected = await options.exec("docker", ["image", "inspect", image.ref]);
    if (inspected.code !== 0) {
      problems.push({
        code: "artifact-unresolvable",
        subject: `image not present in the local store: ${image.ref}`,
        fix: `Nothing is deployed. ${VENDOR_HINT}`,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Human-readable rendering, matching the provisioning core's prose style. */
export function renderCheck(problems: ProvisionProblem[]): string[] {
  return problems.flatMap((problem) => [problem.subject, problem.fix]);
}
