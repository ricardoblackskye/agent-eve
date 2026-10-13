import { createLocalSandboxProvider } from "./local-sandbox";
import { createDryRunSandboxProvider, type SandboxProvider } from "./sandbox";

/**
 * #280 (R1) — resolve the sandbox provider from the environment.
 *
 * The feature is OFF by default and fail-closed: an unset (or blank) `DF_SANDBOX_DRIVER` means the
 * local filesystem, i.e. today's behaviour. There is deliberately NO boolean "enable" flag, because
 * a boolean can default open while a driver NAME cannot. An unknown value throws BEFORE any side
 * effect rather than falling back to something permissive.
 *
 * `opensandbox` is added in R2 (#281); until then it lands in the unknown-value branch, which
 * refuses.
 */

/** The drivers this release can select. Not the same as the `SandboxDriver` union, which also
 * includes the internal `refusing` state. */
export const SUPPORTED_SANDBOX_DRIVERS = ["local", "dry-run"] as const;

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
}

export function createSandboxProvider(
  env: SandboxEnv = { DF_SANDBOX_DRIVER: process.env.DF_SANDBOX_DRIVER },
): SandboxProvider {
  const requested = (env.DF_SANDBOX_DRIVER ?? "").trim();

  // Absence = today's behaviour. This is the fail-closed default, not a permissive one.
  if (requested === "" || requested === "local") return createLocalSandboxProvider();
  if (requested === "dry-run") return createDryRunSandboxProvider();

  throw new SandboxConfigError(
    `Unsupported DF_SANDBOX_DRIVER '${requested}'. Supported values: ${SUPPORTED_SANDBOX_DRIVERS.join(", ")}.`,
  );
}
