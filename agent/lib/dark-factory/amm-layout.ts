/**
 * #426 - where each signal's check lives in a SPECIFIC repository.
 *
 * The catalogue declares WHAT to look for; this declares WHERE. The split exists because the scanner runs against
 * repositories other than the one the catalogue was written against: ten rows name locations that only exist in this
 * repository (`agent/lib/dark-factory/sandbox.ts`, `docs/adr/0006-provider-neutral-seams.md`, ...). Left in the
 * catalogue they would report ABSENT against every other repository - a false negative wearing the costume of a
 * measurement.
 *
 * So those ten rows carry NO path in the catalogue, and a layout supplies it. A repository we have no layout for gets
 * UNMEASURED on those rows, never absent: we never looked, so we cannot report having looked and found nothing.
 *
 * Three of the paths below CORRECT errors in the catalogue: `remote-execution`, `diff-capture` and `vault-injection`
 * named bare filenames while the files live under `agent/lib/dark-factory/`, so even a scan of this repository
 * reported a false absent. `sandbox-seam` next door always used the full path.
 *
 * A path here that names a file which does not exist is NOT an error: `persistent-sessions` points at a capability
 * the product does not have (#430), and absent is the correct reading. Only a MISSING entry would hide a signal, by
 * turning "we looked and it is not there" into "we never looked".
 */
import type { AmmSignalDefinition } from "./amm-signals";

/** Signal id to a path relative to the repository root. */
export type AmmRepoLayout = Readonly<Record<string, string>>;

/** The repository this catalogue was written against. Its layout is the only one we can supply today. */
export const REFERENCE_REPO = "ricardoblackskye/agent-eve";

/**
 * The layout of the reference repository.
 *
 * Every row whose target is this repository's own module lives here, so the catalogue stays generic. A path pointing
 * at a file that is genuinely absent is deliberate - see `persistent-sessions`.
 */
export const referenceAmmLayout: AmmRepoLayout = {
  "sandbox-seam": "agent/lib/dark-factory/sandbox.ts",
  "remote-execution": "agent/lib/dark-factory/opensandbox-driver.ts",
  "persistent-sessions": "agent/lib/dark-factory/session-resume.ts",
  "provider-seams": "docs/adr/0006-provider-neutral-seams.md",
  "structured-logging": "agent/lib/dark-factory/run-history.ts",
  "run-ledger": "agent/lib/dark-factory/run-history-store.ts",
  "diff-capture": "agent/lib/dark-factory/diff-capture.ts",
  "spend-events": "agent/lib/dark-factory/usage-store.ts",
  "vault-injection": "agent/lib/dark-factory/opensandbox-credential-vault.ts",
  rls: "db/migrations/006_df_rls_coverage.sql",
};

/**
 * The layout to use for a repository, or undefined when we have none.
 *
 * Undefined is a legitimate answer: an unknown repository gets its generic rows measured and its repo-specific rows
 * reported unmeasured, rather than measured against a layout that is not its own.
 */
export function layoutFor(repo: string): AmmRepoLayout | undefined {
  return repo === REFERENCE_REPO ? referenceAmmLayout : undefined;
}

/**
 * The path a row's check should read, or undefined when nothing tells us where to look.
 *
 * The order matters: a layout entry WINS over the row's own path, so a repository that keeps its spell-check config
 * somewhere unusual can say so without editing the catalogue. `undefined` means the caller must report unmeasured
 * rather than absent.
 */
export function resolveSignalPath(
  row: Pick<AmmSignalDefinition, "id" | "check">,
  layout?: AmmRepoLayout,
): string | undefined {
  if (row.check.kind !== "file") return undefined;
  return layout?.[row.id] ?? row.check.path;
}