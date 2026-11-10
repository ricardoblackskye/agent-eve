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
 * #383 / #620 — an UNCONFIGURED run is now ISOLATED by default. An unset or blank `DF_SANDBOX_DRIVER`
 * resolves to `opensandbox` rather than defaulting to the local filesystem, so a run that never
 * mentions a driver is contained instead of silently writing generated code, committing and pushing on
 * a real filesystem. Say `DF_SANDBOX_DRIVER=local` to opt out onto the host tree, or
 * `DF_SANDBOX_DRIVER=opensandbox` to isolate explicitly. The explicit host-tree flag is retained
 * (#383): `local` is honoured below and an unknown value still refuses.
 *
 * The "isolated by default" half of #383's AC1 shipped in #620. It was blocked on #585 (CLI contract)
 * and #603 (binary acquisition), both now closed, so provisioning is callable without a manually placed
 * helm binary. Fail-closed is preserved downstream: opensandbox creation refuses when no sandbox is
 * reachable, so an operator is never silently placed on the host.
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
  let requested = (env.DF_SANDBOX_DRIVER ?? "").trim();
  const vaultRequested = (env.DF_SANDBOX_VAULT_ENABLED ?? "").trim().length > 0;

  // #383 / #620 — ISOLATE BY DEFAULT. An unset/blank driver reaches a sandbox (opensandbox) instead
  // of refusing. The host tree still requires an explicit `=local` opt-out (honoured below); an
  // unknown value still refuses. Fail-closed happens downstream: opensandbox creation is lazy and
  // refuses when no sandbox is reachable, so an operator is never silently placed on the host.
  if (requested === "") requested = "opensandbox";

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
