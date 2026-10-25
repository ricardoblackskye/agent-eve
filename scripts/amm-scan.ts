#!/usr/bin/env tsx
/**
 * `npm run df:amm-scan` — measure a repository against the AMM catalogue and print the scan (#426 R2).
 *
 * This is the command that replaces the fixture: `fixtureAmmProvider()` reports a hard-coded scan of this repository,
 * and this reports what a scan of ANY repository actually found. Run it against a checkout to see the difference.
 *
 * Command checks need a sandbox. Without one configured they come back `unmeasured` rather than running on this host,
 * so a scan here measures the file checks and refuses to guess about the rest — see #426 R3, which supplies the sandbox.
 *
 *   npm run df:amm-scan -- --repo ricardoblackskye/agent-eve --workspace .
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { resolveScanProvider, runAmmScan } from "../agent/lib/dark-factory/amm-scan-runner";
import {
  recordAmmScan,
  type AmmScanStoreEnv,
  type RecordScanOutcome,
} from "../agent/lib/dark-factory/amm-scan-provider";
import type { AmmRepoLayout } from "../agent/lib/dark-factory/amm-layout";

interface Parsed {
  repo: string;
  workspace: string;
  layoutPath?: string;
  /** Optional attribution. Absent means UNASSIGNED, which the store treats as a legitimate state. */
  tenant?: string;
}

export function parseArgs(argv: string[]): Parsed | { error: string } {
  let repo: string | undefined;
  let workspace: string | undefined;
  let layoutPath: string | undefined;
  let tenant: string | undefined;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repo") repo = args[++i];
    else if (arg === "--workspace") workspace = args[++i];
    else if (arg === "--layout") layoutPath = args[++i];
    else if (arg === "--tenant") tenant = args[++i];
    else return { error: `unknown argument: ${arg}` };
  }

  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "--repo owner/repo is required" };
  if (!workspace) return { error: "--workspace <dir> is required" };
  return { repo, workspace, layoutPath, tenant };
}

/** A layout supplied as JSON, so a repository we have no built-in layout for can still be measured. */
function readLayout(path: string): AmmRepoLayout {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object of signal id to path`);
  }
  const layout: Record<string, string> = {};
  for (const [signalId, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`${path}: ${signalId} must map to a path string`);
    layout[signalId] = value;
  }
  return layout;
}

/**
 * #465 - what the command's exit code means. 0 = the scan was measured (and, with a store configured, persisted);
 * 1 = a configured store REFUSED it, so the measurement is lost. "Printed but not persisted" is 0: measuring and
 * printing is still a legitimate use.
 */
export function exitCodeFor(outcome: RecordScanOutcome): number {
  if (outcome.recorded) return 0;
  return outcome.configured ? 1 : 0;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  // #437 - command checks run ONLY through an isolated provider; anything else refuses, so a scan
  // never executes a repository's code on this machine.
  const choice = resolveScanProvider();
  // #437 - report what the scan DID, not what the provider was. A resolved sandbox is not evidence
  // that any command ran, and the two were conflated here.
  const commandNotes: string[] = [];
  const scan = await runAmmScan({
    repo: parsed.repo,
    workspace: parsed.workspace,
    ...(parsed.layoutPath ? { layout: readLayout(parsed.layoutPath) } : {}),
    provider: choice.provider,
    onCommandNote: (note: string) => commandNotes.push(note),
  });

  const measured = scan.pillars
    .flatMap((pillar) => pillar.signals ?? [])
    .filter((signal) => signal.state !== "unmeasured").length;
  const total = scan.pillars.flatMap((pillar) => pillar.signals ?? []).length;

  process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
  process.stderr.write(
    `\n${scan.repo}: ${scan.overall.label} — ${scan.overall.points}/${scan.overall.maxPoints}\n` +
      `${measured}/${total} signals measured (the rest could not be measured and are NOT counted absent)\n` +
      (choice.refused
        ? `command checks were NOT measured: ${choice.refused}
`
        : "") +
      (commandNotes.length > 0 ? `command checks did NOT run: ${commandNotes.join("; ")}
`
 : "") +
      `catalogue ${scan.catalogueVersion}\n`,
  );

  // #465 - the write link. A measurement that is never persisted exists only in this terminal, which is how the
  // scanner came to be invisible to the pages.
  const record = await recordAmmScan(scan, process.env as AmmScanStoreEnv, parsed.tenant);
  process.stderr.write(
    record.recorded
      ? `persisted to ${record.storeId} as row ${record.rowId}\n`
      : `NOT persisted: ${record.reason ?? "no reason given"}\n`,
  );
  return exitCodeFor(record);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`df:amm-scan failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
