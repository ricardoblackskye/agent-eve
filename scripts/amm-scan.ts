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

import { runAmmScan } from "../agent/lib/dark-factory/amm-scan-runner";
import type { AmmRepoLayout } from "../agent/lib/dark-factory/amm-layout";

interface Parsed {
  repo: string;
  workspace: string;
  layoutPath?: string;
}

function parseArgs(argv: string[]): Parsed | { error: string } {
  let repo: string | undefined;
  let workspace: string | undefined;
  let layoutPath: string | undefined;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repo") repo = args[++i];
    else if (arg === "--workspace") workspace = args[++i];
    else if (arg === "--layout") layoutPath = args[++i];
    else return { error: `unknown argument: ${arg}` };
  }

  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "--repo owner/repo is required" };
  if (!workspace) return { error: "--workspace <dir> is required" };
  return { repo, workspace, layoutPath };
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

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  const scan = await runAmmScan({
    repo: parsed.repo,
    workspace: parsed.workspace,
    ...(parsed.layoutPath ? { layout: readLayout(parsed.layoutPath) } : {}),
  });

  const measured = scan.pillars
    .flatMap((pillar) => pillar.signals ?? [])
    .filter((signal) => signal.state !== "unmeasured").length;
  const total = scan.pillars.flatMap((pillar) => pillar.signals ?? []).length;

  process.stdout.write(`${JSON.stringify(scan, null, 2)}\n`);
  process.stderr.write(
    `\n${scan.repo}: ${scan.overall.label} — ${scan.overall.points}/${scan.overall.maxPoints}\n` +
      `${measured}/${total} signals measured (the rest could not be measured and are NOT counted absent)\n` +
      `catalogue ${scan.catalogueVersion}\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`df:amm-scan failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
