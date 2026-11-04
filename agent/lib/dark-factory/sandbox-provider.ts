import { createLocalSandboxProvider } from "./local-sandbox";
import type { GitPushCredentialOptions } from "./opensandbox-credential-vault";
import {
  createLiveSandbox,
  createOpenSandboxProvider,
} from "./opensandbox-driver";
import { createDryRunSandboxProvider, type SandboxProvider } from "./sandbox";

/**
 * #280 (R1) — resolve the sandbox provider from the environment.
 *
 * There is deliberately NO boolean "enable" flag, because a boolean can default open while a driver
 * NAME cannot. An unknown value throws BEFORE any side effect rather than falling back to something
 * permissive.
 *
 * #383 — the host tree now requires an EXPLICIT flag. An unset or blank `DF_SANDBOX_DRIVER` REFUSES
 * rather than defaulting to the local filesystem. The old default was fail-closed against
 * misconfiguration but not against isolation: a run that never mentioned a driver silently wrote
 * generated code, committed and pushed on a real filesystem. Say `DF_SANDBOX_DRIVER=local` to opt
 * out, or `DF_SANDBOX_DRIVER=opensandbox` to isolate. Refusing is the honest default when we cannot
 * tell whether the operator meant to run on the host.
 *
 * Still outstanding from #383's AC1: "isolated by default" in the sense that an UNCONFIGURED run
 * automatically reaches a sandbox. That needs provisioning to be callable without a manually placed
 * helm binary, which is #585. Until then an unconfigured run refuses loudly instead of guessing.
 */

/** The drivers this release can select. Not the same as the `SandboxDriver` union, which also
 * includes the internal `refusing` state. */
export const SUPPORTED_SANDBOX_DRIVERS = [
  "local",
  "dry-run",
  "opensandbox",
] as const;

export class SandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxConfigError";
  }
}

/**
 * Only the knob this factory reads, so callers (and tests) need not construct a whole `ProcessEnv`
 * — this repo augments `ProcessEnv` to require `NODE_ENV`, which a test fixture has no business
 * supplying.
 */
export interface SandboxEnv {
  DF_SANDBOX_DRIVER?: string | undefined;
  /** #282 (R3) — opt-in gate for the OpenSandbox credential proxy (vault-backed sandbox wiring). */
  DF_SANDBOX_VAULT_ENABLED?: string | undefined;
}

export function createSandboxProvider(
  env: SandboxEnv = {
    DF_SANDBOX_DRIVER: process.env.DF_SANDBOX_DRIVER,
    DF_SANDBOX_VAULT_ENABLED: process.env.DF_SANDBOX_VAULT_ENABLED,
  },
  _deps: {
    createSandbox?: typeof createLiveSandbox;
    /** #354 — the push credential seeded into the sandbox-local vault on the vault path. */
    gitPushCredential?: GitPushCredentialOptions;
  } = {},
  runId?: string | undefined,
): SandboxProvider {
  const requested = (env.DF_SANDBOX_DRIVER ?? "").trim();
  const vaultRequested = (env.DF_SANDBOX_VAULT_ENABLED ?? "").trim().length > 0;

  // #282 (R3) — FAIL-CLOSED: vault-backed wiring needs a vault-capable backend. Asking for the gate
  // while the resolved driver cannot honour it REFUSES before any selection, rather than silently
  // running a push whose token was never vault-injected.
  if (vaultRequested && requested !== "opensandbox") {
    throw new SandboxConfigError(
      `DF_SANDBOX_VAULT_ENABLED requires DF_SANDBOX_DRIVER=opensandbox (` +
        `${requested === "" ? "no driver is set" : `received '${requested}'`}). Refusing to fall ` +
        `back to a non-vault sandbox: the push token would not be vault-injected.`,
    );
  }

  // #383 — REFUSE on absence. The previous line returned the local provider for an unset driver,
  // which meant a run that never mentioned a driver quietly wrote code, committed and pushed on the
  // real filesystem. That is closed against misconfiguration but not against isolation. An explicit
  // `local` is still honoured below; only the silent fallback is removed.
  if (requested === "") {
    throw new SandboxConfigError(
      "DF_SANDBOX_DRIVER is not set. An unconfigured run must not default to the host tree (#383): " +
        "set DF_SANDBOX_DRIVER=local to run on the host filesystem, or " +
        "DF_SANDBOX_DRIVER=opensandbox to run isolated in a sandbox.",
    );
  }
  if (requested === "local") return createLocalSandboxProvider();
  if (requested === "dry-run") return createDryRunSandboxProvider();
  if (requested === "opensandbox") {
    // Live execution inside a sandbox. Egress is deny-by-default, so the gateway host is the only
    // reachable destination unless explicitly widened.
    return createOpenSandboxProvider(
      {
        DF_SANDBOX_IMAGE: process.env.DF_SANDBOX_IMAGE,
        DF_SANDBOX_TIMEOUT_SECONDS: process.env.DF_SANDBOX_TIMEOUT_SECONDS,
        DF_SANDBOX_EGRESS_ALLOW: process.env.DF_SANDBOX_EGRESS_ALLOW,
        DF_SANDBOX_EGRESS_GATEWAY_HOST:
          process.env.DF_SANDBOX_EGRESS_GATEWAY_HOST,
        DF_SANDBOX_EGRESS_GIT_HOST: process.env.DF_SANDBOX_EGRESS_GIT_HOST,
        DF_SANDBOX_WORKSPACE: process.env.DF_SANDBOX_WORKSPACE,
        DF_SANDBOX_VAULT_ENABLED: process.env.DF_SANDBOX_VAULT_ENABLED,
      },
      {
        createSandbox: _deps.createSandbox ?? createLiveSandbox,
        metadata: runId ? { run: runId } : undefined,
        ...(_deps.gitPushCredential
          ? { gitPushCredential: _deps.gitPushCredential }
          : {}),
      },
    );
  }

  throw new SandboxConfigError(
    `Unsupported DF_SANDBOX_DRIVER '${requested}'. Supported values: ${SUPPORTED_SANDBOX_DRIVERS.join(", ")}.`,
  );
}
