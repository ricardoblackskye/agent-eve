/**
 * #585 T6 (AC1/AC6) - flag parsing and secret refusal.
 *
 * AC1 asks for ONE entry point configured by flags instead of the bootstrap/sandbox-up split.
 * That only holds if the flags are parsed in one place, so this module is the single parser and
 * the CLI does not inspect argv itself.
 *
 * AC6 asks that no secret ever appears on the command line. A token on argv is visible in the
 * process table to every user on the box, and it lands in shell history and CI logs. So secret
 * flags are REFUSED rather than accepted: the refusal names the flag and never the value, and
 * points the operator at stdin or a vault handle. A parser that quietly accepted `--token` and
 * redacted it later would still have leaked it into the process table by the time it ran.
 *
 * Usage errors return exit code 2. They are deliberately outside the ProvisionProblemCode table
 * (see sandbox-exit-codes.ts): a bad flag is caught before provisioning starts, so it cannot be
 * a provisioning failure and must not share a number with one.
 *
 * No dependency: a hand-rolled loop over the argument array. Adding a parser library for eight
 * flags would be a dependency to keep current for no gain, and the refusal rules are ours to
 * own anyway.
 */
import type { SandboxCluster } from "./sandbox-provisioning";

/** Usage errors are not provisioning failures, so 2 sits outside the problem table. */
export const USAGE_EXIT_CODE = 2;

export interface ParsedFlags {
  /** Run the read-only preflight and stop. */
  check: boolean;
  /** Print the usage text and stop. */
  help: boolean;
  /** Print the CLI version and stop. */
  version: boolean;
  forwardPort?: number;
  cluster?: SandboxCluster;
  artifactsDir?: string;
  workspaceDir?: string;
}

export type FlagError =
  | { kind: "unknown-flag"; flag: string }
  | { kind: "secret-on-argv"; flag: string }
  | { kind: "missing-value"; flag: string }
  | { kind: "invalid-value"; flag: string; reason: string };

export interface ParseResult {
  flags: ParsedFlags;
  errors: FlagError[];
}

export const USAGE = `Usage: npm run df:sandbox-up -- [flags]

Provisions the local OpenSandbox control plane and proves it works. stdout carries NDJSON
progress events; human prose goes to stderr. Exits non-zero on any failure.

Flags:
  --check                  Run the read-only preflight and stop. Probes the required binaries
                           (verified against scripts/sandbox-vendor/artifacts.lock.json), the
                           artifact lock, the image cache and the local image store. Starts no
                           cluster, pulls no image and writes no state. Exits 10 when a
                           prerequisite is missing, 15 when a binary version or digest mismatches
                           the manifest, and 11 when an artifact is unresolvable.
  --help                   Print this text and stop.
  --version                Print the CLI version and stop.
  --forward-port <port>    Local port to forward the control plane to. Default 18082.
  --cluster <name>         Cluster target. "minikube" starts or reuses a local minikube.
  --kube-context <name>    Target an EXISTING cluster by context instead of minikube. Takes
                           precedence over --cluster. kubectl must be able to reach it.
  --kubeconfig <path>      Kubeconfig to use with --kube-context. Defaults to kubectl's own.
  --artifacts-dir <path>   Directory holding artifacts.lock.json and cache/. Default
                           scripts/sandbox-vendor.
  --workspace-dir <path>   Workspace root. Default the repository root.

Secrets are NOT accepted on the command line:
  --token <value>          REFUSED. A token on argv is visible in the process table and in shell
                           history. Pass it on stdin or use a vault handle instead. The same rule
                           applies to --password, --api-key and --secret.

Examples:
  npm run df:sandbox-up -- --check
  npm run df:sandbox-up
  npm run df:sandbox-up -- --kube-context prod-east --kubeconfig C:/kube/config
`;

/** Flags that carry a value in the next token. */
const VALUE_FLAGS = new Set([
  "--forward-port",
  "--cluster",
  "--kube-context",
  "--kubeconfig",
  "--artifacts-dir",
  "--workspace-dir",
]);

/** Flags whose value is a secret. Refused outright, never stored. */
const SECRET_FLAGS = ["--token", "--password", "--api-key", "--secret"];

const SECRET_REASON =
  "a secret on the command line is visible in the process table and in shell history; " +
  "pass it on stdin or use a vault handle instead";

/** True when the token looks like `--flag=value` for one of the secret flags. */
function secretFlagName(token: string): string | undefined {
  for (const flag of SECRET_FLAGS) {
    if (token === flag || token.startsWith(`${flag}=`)) return flag;
  }
  return undefined;
}

/**
 * Parse the argument array into flags plus usage errors. Every error is collected rather than
 * thrown, so the operator sees all the problems in one run instead of fixing them one at a time.
 *
 * The parser never stores a secret: when a secret flag is seen, its following token is consumed
 * so it cannot be mistaken for a positional argument, and the value is discarded unread.
 */
export function parseFlags(argv: readonly string[]): ParseResult {
  const errors: FlagError[] = [];
  const raw = new Map<string, string>();
  let check = false;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (token === "--check") {
      check = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--version") {
      version = true;
      continue;
    }

    const secret = secretFlagName(token);
    if (secret) {
      errors.push({ kind: "secret-on-argv", flag: secret });
      // Consume the separate value form so it is neither stored nor reported as unknown.
      if (token === secret) index += 1;
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const flagName = equalsIndex > 0 ? token.slice(0, equalsIndex) : token;

    if (!VALUE_FLAGS.has(flagName)) {
      errors.push({ kind: "unknown-flag", flag: token });
      continue;
    }

    let value: string | undefined;
    if (equalsIndex > 0) {
      value = token.slice(equalsIndex + 1);
    } else {
      value = argv[index + 1];
      // A following flag is not a value; treat the value as absent.
      if (value === undefined || value.startsWith("--")) {
        errors.push({ kind: "missing-value", flag: flagName });
        continue;
      }
      index += 1;
    }

    if (value === "") {
      errors.push({ kind: "missing-value", flag: flagName });
      continue;
    }

    raw.set(flagName, value);
  }

  const flags: ParsedFlags = { check, help, version };

  const artifactsDir = raw.get("--artifacts-dir");
  if (artifactsDir !== undefined) flags.artifactsDir = artifactsDir;

  const workspaceDir = raw.get("--workspace-dir");
  if (workspaceDir !== undefined) flags.workspaceDir = workspaceDir;

  const port = raw.get("--forward-port");
  if (port !== undefined) {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      errors.push({
        kind: "invalid-value",
        flag: "--forward-port",
        reason: "expected an integer between 1 and 65535",
      });
    } else {
      flags.forwardPort = parsed;
    }
  }

  const context = raw.get("--kube-context");
  const kubeconfig = raw.get("--kubeconfig");
  const cluster = raw.get("--cluster");

  if (context !== undefined) {
    // --kube-context takes precedence over --cluster: naming a context is the more specific
    // instruction, and silently ignoring it would target the wrong cluster.
    flags.cluster = kubeconfig === undefined ? { context } : { context, kubeconfig };
  } else if (cluster !== undefined) {
    flags.cluster = cluster === "minikube" ? "minikube" : { context: cluster };
  } else if (kubeconfig !== undefined) {
    errors.push({
      kind: "invalid-value",
      flag: "--kubeconfig",
      reason: "requires --kube-context to name the cluster",
    });
  }

  return { flags, errors };
}

/** Human-readable rendering of usage errors. Never includes a secret value. */
export function renderFlagErrors(errors: FlagError[]): string[] {
  return errors.map((error) => {
    switch (error.kind) {
      case "unknown-flag":
        return `unknown flag: ${error.flag}. Run with --help to see the accepted flags.`;
      case "secret-on-argv":
        return `refused ${error.flag}: ${SECRET_REASON}.`;
      case "missing-value":
        return `${error.flag} requires a value.`;
      case "invalid-value":
        return `${error.flag} is invalid: ${error.reason}.`;
    }
  });
}
