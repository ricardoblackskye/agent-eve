/**
 * #585 T5 (AC5) + #603 T2 (D2/D3) - the read-only preflight check.
 *
 * WHY THIS EXISTS: the only way to learn whether a sandbox run could work was to start one. A
 * missing helm or a stopped Docker daemon surfaced only after minikube had already been started,
 * and the operator discovered the second missing prerequisite only after fixing the first.
 * `--check` answers "would this work?" up front and mutates nothing.
 *
 * #603 D2/D3: the binary prerequisites are now MANIFEST-DRIVEN. The check reads
 * scripts/sandbox-vendor/artifacts.lock.json, probes each required binary's version using the
 * probe command declared in the manifest, and refuses before any state-changing stage runs:
 *   - a binary that will not execute at all  -> `prerequisites-missing` (exit 10)
 *   - a binary present but wrong version/digest -> `prerequisites-mismatch` (exit 15)
 * The manifest is the single source for what is required and how to probe it, so the list is data,
 * not code. A malformed manifest fails closed (artifact-unresolvable) rather than running blind.
 *
 * THE RULE THAT MATTERS: this module issues READ-ONLY probes only. Every command below is a
 * version query or an inspect. It never starts a cluster, runs an upgrade, pulls an image or
 * writes the state file.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ExecFn,
  ProvisionProblem,
  SandboxCluster,
} from "./sandbox-provisioning";
import {
  extractVersion,
  parseManifest,
  satisfiesRange,
  type SandboxManifest,
} from "./sandbox-manifest";
import { digestOfFile as defaultDigestOfFile } from "./sandbox-state";

export interface CheckOptions {
  /** Directory holding artifacts.lock.json and cache/ (scripts/sandbox-vendor). */
  artifactsDir: string;
  /** The cluster target. A local target needs minikube; an existing one does not. */
  cluster: SandboxCluster;
  /** Injected so the checks stay testable without Docker, a cluster or a network. */
  exec: ExecFn;
  /**
   * Resolve a binary command name to its on-disk path. Injected for tests; defaults to `where`
   * (Windows) / `which` (POSIX) so digest verification can read the actual file. Optional because
   * digest verification is opt-in per manifest entry (`expectedDigest`); when absent, this is never
   * called.
   */
  resolveBinaryPath?: (command: string) => Promise<string | null>;
  /**
   * Compute a file's sha256. Injected for tests; defaults to the real `digestOfFile`. Only invoked
   * for manifest entries that record an `expectedDigest`.
   */
  digestOfFile?: (path: string) => string;
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
  images: LockImage[];
}

/**
 * Probe every required binary from the manifest and collect ALL failures in one pass. A binary that
 * will not execute is `prerequisites-missing`; one present but outside its version constraint is
 * `prerequisites-mismatch`. Reporting one at a time would make the operator loop over installs.
 */
async function verifyBinaries(
  manifest: SandboxManifest,
  cluster: SandboxCluster,
  exec: ExecFn,
  resolveBinaryPath: (command: string) => Promise<string | null>,
  digestOfFile: (path: string) => string,
): Promise<ProvisionProblem[]> {
  const problems: ProvisionProblem[] = [];
  for (const bin of manifest.binaries) {
    const required = bin.required || bin.requiredFor === cluster;
    if (!required) continue;

    const result = await exec(bin.probe.command, bin.probe.args);
    if (result.code !== 0) {
      problems.push({
        code: "prerequisites-missing",
        subject: `missing prerequisite: ${bin.name} is not usable`,
        fix: bin.fix,
      });
      continue;
    }

    const version = extractVersion(result.stdout);
    if (version === null || !satisfiesRange(version, bin.versionConstraint)) {
      const actual = version ?? "(unknown version)";
      problems.push({
        code: "prerequisites-mismatch",
        subject: `binary version mismatch: ${bin.name} is ${actual} but the manifest requires ${bin.versionConstraint}`,
        fix: bin.fix,
      });
      continue;
    }

    // Version is good. When the manifest records a digest, verify the actual binary file against
    // it (D3: refuse on digest mismatch too). Skip silently if the path cannot be resolved - the
    // version probe already proved the binary is present and runnable.
    if (bin.expectedDigest) {
      const path = await resolveBinaryPath(bin.probe.command);
      if (path) {
        const actual = normalizeDigest(digestOfFile(path));
        const expected = normalizeDigest(bin.expectedDigest);
        if (actual !== expected) {
          problems.push({
            code: "prerequisites-mismatch",
            subject: `binary digest mismatch: ${bin.name} (${actual}) does not match the manifest (${expected})`,
            fix: bin.fix,
          });
        }
      }
    }
  }
  return problems;
}

/** Compare digests regardless of a `sha256:` prefix or hex casing. */
function normalizeDigest(digest: string): string {
  return digest.replace(/^sha256:/i, "").toLowerCase();
}

/**
 * Best-effort path resolution for a command name. `where` on Windows, `which` elsewhere. Returns
 * null when the binary cannot be located, in which case digest verification is skipped.
 */
async function defaultResolveBinaryPath(
  command: string,
  exec: ExecFn,
): Promise<string | null> {
  const finder = process.platform === "win32" ? "where" : "which";
  const res = await exec(finder, [command]);
  if (res.code !== 0 || !res.stdout.trim()) return null;
  return res.stdout.trim().split(/\r?\n/)[0] ?? null;
}

export async function checkPrerequisites(options: CheckOptions): Promise<CheckResult> {
  const problems: ProvisionProblem[] = [];

  const lockPath = join(options.artifactsDir, "artifacts.lock.json");
  if (!existsSync(lockPath)) {
    problems.push({
      code: "artifact-unresolvable",
      subject: `the vendor lock is missing: ${lockPath}`,
      fix: `Nothing is deployed. ${VENDOR_HINT}`,
    });
    return { ok: problems.length === 0, problems };
  }

  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push({
      code: "artifact-unresolvable",
      subject: `the vendor lock is not readable (${lockPath})`,
      fix: message,
    });
    return { ok: false, problems };
  }

  // The manifest owns the binary contract. A malformed one is an unresolvable artifact, never a
  // silent pass - we must not provision against a lock we cannot trust.
  let manifest: SandboxManifest;
  try {
    manifest = parseManifest(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push({
      code: "artifact-unresolvable",
      subject: `the vendor lock is malformed: ${lockPath}`,
      fix: message,
    });
    return { ok: false, problems };
  }

  problems.push(
    ...(await verifyBinaries(
      manifest,
      options.cluster,
      options.exec,
      options.resolveBinaryPath ?? ((cmd) => defaultResolveBinaryPath(cmd, options.exec)),
      options.digestOfFile ?? defaultDigestOfFile,
    )),
  );

  // Read-only: inspect only. A missing image is named so the operator knows which one.
  let lock: Lock;
  try {
    lock = JSON.parse(raw) as Lock;
  } catch {
    lock = { images: [] };
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
