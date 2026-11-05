/**
 * #603 T1 (D2) - the binary manifest, owned in-repo.
 *
 * WHY THIS EXISTS: #584 decision D2 says the repo owns the manifest (versions + digests) even if
 * the Phase 2 program does the actual download. `scripts/sandbox-vendor/artifacts.lock.json`
 * already tracked the chart, CRDs and images; this module adds the `binaries` section that lists
 * every CLI prerequisite the sandbox needs, with the command that probes its version so the check
 * stays data-driven rather than hard-coded.
 *
 * THE RULE THAT MATTERS: parsing fails closed. A missing field, a bad `acquiredBy`, or a probe
 * that is not `{command, args}` throws. The caller turns that into a refusal - we never silently
 * run with an unverifiable manifest.
 *
 * No semver dependency exists in this repo, so `satisfiesRange` is a deliberately tiny matcher
 * covering `>=`, `<=`, `==`, `^` and bare-exact. That is enough for binary version pins; pulling
 * in a dependency for four operators would be over-engineering.
 */
export interface BinaryManifestEntry {
  /** Canonical name, used in refusal messages and as the lookup key. */
  name: string;
  /** Version pin, e.g. ">=3.14.0", "^3.14.0", "==3.14.0", "3.14.0". */
  versionConstraint: string;
  /** Baseline requirement for every target. Use requiredFor for cluster-specific extras. */
  required: boolean;
  /** When set, the binary is additionally required only for this cluster target. */
  requiredFor?: "minikube";
  /** Who is expected to place the binary: the program (Phase 2) or the operator. */
  acquiredBy: "program" | "operator";
  /** Read-only probe that emits the installed version. */
  probe: { command: string; args: string[] };
  /** Actionable instruction shown when the binary is missing or mismatched. */
  fix: string;
  /** Optional recorded digest; when present the CLI verifies the binary file against it. */
  expectedDigest?: string;
}

export interface SandboxManifest {
  binaries: BinaryManifestEntry[];
}

const REQUIRED_FIELDS: (keyof BinaryManifestEntry)[] = [
  "name",
  "versionConstraint",
  "required",
  "acquiredBy",
  "probe",
  "fix",
];

/**
 * Pull the first `x.y.z` (optionally `v`-prefixed) out of noisy CLI output such as
 * `Client Version: v1.29.0`, `v3.14.4+gabc123` or `Python 3.11.15`. Returns null when no version
 * is present - the caller then treats the probe as a failure.
 */
export function extractVersion(raw: string): string | null {
  const match = raw.match(/v?(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function parseConstraint(constraint: string): { op: ">=" | "<=" | "==" | "^" | ""; version: number[] } {
  const m = constraint.match(/^(>=|<=|==|\^)?\s*v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) {
    throw new Error(`invalid version constraint: ${constraint}`);
  }
  return {
    op: (m[1] ?? "") as ">=" | "<=" | "==" | "^" | "",
    version: [Number(m[2]), Number(m[3]), Number(m[4])],
  };
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** True when `version` satisfies `constraint`. Throws on a malformed version or constraint. */
export function satisfiesRange(version: string, constraint: string): boolean {
  const vMatch = version.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!vMatch) {
    throw new Error(`invalid version: ${version}`);
  }
  const v = [Number(vMatch[1]), Number(vMatch[2]), Number(vMatch[3])];
  const { op, version: c } = parseConstraint(constraint);
  const relation = compare(v, c);
  switch (op) {
    case ">=":
      return relation >= 0;
    case "<=":
      return relation <= 0;
    case "==":
      return relation === 0;
    case "^":
      // Major-pinned: same major, and at or above the floor.
      return v[0] === c[0] && relation >= 0;
    case "":
      return relation === 0;
    default:
      return false;
  }
}

/** Parse and validate the manifest. Throws on any malformed binaries entry - fail closed. */
export function parseManifest(json: string): SandboxManifest {
  const data = JSON.parse(json) as unknown;
  if (typeof data !== "object" || data === null) {
    throw new Error("manifest is not an object");
  }
  const binaries = (data as { binaries?: unknown }).binaries;
  if (!Array.isArray(binaries)) {
    throw new Error("manifest.binaries must be an array");
  }
  for (const entry of binaries as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("binary manifest entry must be an object");
    }
    const record = entry as Record<string, unknown>;
    for (const field of REQUIRED_FIELDS) {
      if (record[field] === undefined) {
        throw new Error(`binary manifest entry missing field: ${field}`);
      }
    }
    const probe = record.probe as { command?: unknown; args?: unknown };
    if (typeof probe?.command !== "string" || !Array.isArray(probe?.args)) {
      throw new Error("binary manifest entry probe must be { command: string; args: string[] }");
    }
    if (record.acquiredBy !== "program" && record.acquiredBy !== "operator") {
      throw new Error("binary manifest entry acquiredBy must be 'program' or 'operator'");
    }
  }
  return { binaries: binaries as BinaryManifestEntry[] };
}
