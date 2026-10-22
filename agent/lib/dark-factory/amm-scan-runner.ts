/**
 * #426 (R2) - the AMM scanner: turn the catalogue into real measurements.
 *
 * #382 built the arithmetic and #424 built the storage; both stop at the edge of I/O. This module IS that edge: it
 * evaluates every catalogue row against a workspace and hands the result to `scoreRepo`, so an AMM figure becomes a
 * measurement of a real repository rather than a fixture.
 *
 * WHERE THE LINE IS DRAWN, and why it is drawn there:
 *
 * - `file` checks are READ-ONLY, so they read the workspace on the host, confined to the workspace root. A read cannot
 *   harm anything, and demanding a sandbox for a read would mean no repository could be measured at all.
 * - `command` checks EXECUTE code, so they run ONLY through a `SandboxProvider`. The default provider REFUSES, so with
 *   no sandbox configured they come back `unmeasured` - never executed on the host, and never reported absent. That is
 *   AC5: "we could not run the linter" is not "the repository has no linter", and the difference is the whole issue.
 *
 * UNMEASURED IS NOT A SOFT ABSENT. It means nobody looked. Counting it as absent would fail a repository on ignorance;
 * counting it as present would let one graduate on it.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import { layoutFor, resolveSignalPath, type AmmRepoLayout } from "./amm-layout";
import type { AmmScan } from "./amm-readiness";
import { scoreRepo, type AmmMeasurement } from "./amm-scoring";
import { AMM_SIGNAL_CATALOGUE, catalogueVersion, type AmmSignalDefinition } from "./amm-signals";
import { createRefusingSandboxProvider, SandboxRefusedError, type SandboxProvider } from "./sandbox";

export interface RunAmmScanInput {
  repo: string;
  /** The repository checkout to read, relative paths resolved against it. */
  workspace: string;
  /** Where this repository keeps its repo-specific targets. Defaults to the reference layout for the reference repo. */
  layout?: AmmRepoLayout;
  /** Where command checks execute. Defaults to a provider that REFUSES, keeping the scan off the host (AC5). */
  provider?: SandboxProvider;
  /** The scan stamp, supplied so a scan is reproducible. */
  now?: () => string;
}

/** A scan plus the catalogue version that produced it, so a scan can be told apart from the model behind it. */
export type AmmScanResult = AmmScan & { catalogueVersion: string };

const REFUSAL = "no sandbox is configured, so no command may run outside one (AC5: refuse, never the host)";

/**
 * Proof that a sandbox actually holds the repository. Without it, a command run in an EMPTY sandbox fails
 * for our reason rather than the repository's, and a non-zero exit is indistinguishable from a real
 * `absent` - our own misprovisioning reported as the repository's failure.
 */
const PROJECT_MARKER = "package.json";

/** Confine a relative path to the workspace. A layout may not point the scanner at the rest of the filesystem. */
function resolveWithin(workspaceRoot: string, relPath: string): string {
  const target = resolve(workspaceRoot, relPath);
  if (target !== workspaceRoot && !target.startsWith(workspaceRoot + sep)) {
    throw new Error(`path escapes the workspace: ${relPath}`);
  }
  return target;
}

/** A read-only check: does the target exist, or does it contain the expected text? */
function measureFile(
  definition: AmmSignalDefinition,
  relPath: string,
  workspaceRoot: string,
): AmmMeasurement {
  const target = resolveWithin(workspaceRoot, relPath);
  const expectation = definition.expectation;
  if (expectation.kind === "exists") {
    return existsSync(target) ? "present" : "absent";
  }
  if (expectation.kind === "contains") {
    if (!existsSync(target)) return "absent";
    return readFileSync(target, "utf8").includes(expectation.text) ? "present" : "absent";
  }
  // A command expectation on a file check is a catalogue error, and guessing at one would invent a measurement.
  return "unmeasured";
}

/** A check that executes: it may only run inside a sandbox, so a refused sandbox yields unmeasured. */
async function measureCommand(
  definition: AmmSignalDefinition,
  provider: SandboxProvider,
  workspaceRoot: string,
): Promise<AmmMeasurement> {
  const expectation = definition.expectation;
  if (definition.check.kind !== "command" || expectation.kind !== "exitCode") return "unmeasured";

  // A command EXECUTES, so it may only run somewhere other than THIS filesystem. `local` is a provider
  // too - and an unset DF_SANDBOX_DRIVER resolves to it - so the gate reads the provider's own `isolated`
  // property rather than trusting the call site to have chosen wisely.
  if (!provider.isolated) return "unmeasured";

  const tools = provider.create(workspaceRoot);

  // Confirm the sandbox holds the project BEFORE anything runs. An unprovisioned sandbox is "nobody
  // looked", never "the repository has no linter", so it is unmeasured and no command is executed.
  let holdsProject = false;
  try {
    holdsProject = (await tools.readFile(PROJECT_MARKER)).trim().length > 0;
  } catch {
    holdsProject = false;
  }
  if (!holdsProject) return "unmeasured";

  const startedAt = Date.now();
  try {
    const result = await tools.runTests(definition.check.command);
    if (expectation.withinMs !== undefined && Date.now() - startedAt > expectation.withinMs) {
      // The time bound IS the signal on these rows: an exit code alone would call a ten-minute run present.
      return "unmeasured";
    }
    return result.passed ? "present" : "absent";
  } catch (err) {
    // No sandbox, a refused sandbox, or missing tooling: it never ran, so nobody looked.
    if (err instanceof SandboxRefusedError) return "unmeasured";
    return "unmeasured";
  }
}

async function measureOne(
  definition: AmmSignalDefinition,
  input: { workspaceRoot: string; layout?: AmmRepoLayout; provider: SandboxProvider },
): Promise<AmmMeasurement> {
  try {
    if (definition.check.kind === "file") {
      const relPath = resolveSignalPath(definition, input.layout);
      // Nothing told us where to look in THIS repository, so we have not looked.
      if (relPath === undefined) return "unmeasured";
      return measureFile(definition, relPath, input.workspaceRoot);
    }
    return await measureCommand(definition, input.provider, input.workspaceRoot);
  } catch {
    // A target we could not read is not a target we found missing, so it is never reported absent.
    return "unmeasured";
  }
}

/**
 * Scan one repository: evaluate the catalogue, then score it.
 *
 * The measurements come back from a real workspace and go into the same pure scorer the tests pin, so a fixture scan
 * and a measured scan are the same shape and the UI needs no change to render either (AC4).
 */
export async function runAmmScan(input: RunAmmScanInput): Promise<AmmScanResult> {
  const provider = input.provider ?? createRefusingSandboxProvider(REFUSAL);
  const layout = input.layout ?? layoutFor(input.repo);
  const now = input.now ?? (() => new Date().toISOString());
  const workspaceRoot = resolve(input.workspace);
  const readable = existsSync(workspaceRoot);

  const measurements: Record<string, AmmMeasurement> = {};
  for (const definition of AMM_SIGNAL_CATALOGUE) {
    measurements[definition.id] = readable
      ? await measureOne(definition, { workspaceRoot, layout, provider })
      : "unmeasured";
  }

  const scan = scoreRepo({ repo: input.repo, measurements, scannedAt: now() });
  return { ...scan, catalogueVersion: catalogueVersion() };
}