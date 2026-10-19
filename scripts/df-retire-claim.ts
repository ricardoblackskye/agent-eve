#!/usr/bin/env tsx
/**
 * `npm run df:retire-claim` — let a stopped run go, so the next one can start (#404 R2).
 *
 * The refusal that prompted this release said: "wait for that run to finish, or retire its claim if the process is
 * gone" — and nothing in the repo could do the second. This is that operation, in one line:
 *
 *     npm run df:retire-claim -- --repo owner/repo --issue 169 [--reason "why"] [--actor me]
 *
 * It refuses a LIVE holder (work in flight is never cut out from under itself), refuses when no claim exists rather
 * than reporting a hollow success, and reconciles the ticket's factory-owned labels so it stops advertising a run.
 *
 * Secrets are read from the environment (the agent's .env.local is loaded here) and never printed.
 */
import { pathToFileURL } from "node:url";
import { loadLocalEnv } from "./load-env";
import { createRunHistoryStore } from "../agent/lib/dark-factory/run-history-provider";
import {
  createGitHubLabelWriter,
  GitHubIssueWriter,
  resolveIssueToken,
} from "../agent/lib/dark-factory/issue-writer";
import { retireStaleClaim, type RetireReport } from "../agent/lib/dark-factory/retire-claim";

export interface RetireArgs {
  repo: string;
  issue: number;
  reason?: string;
  actor?: string;
}

export function parseRetireArgs(argv: string[]): RetireArgs | { error: string } {
  let repo: string | undefined;
  let issue: number | undefined;
  let reason: string | undefined;
  let actor: string | undefined;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo") repo = args[++i];
    else if (arg === "--issue") issue = Number(args[++i]);
    else if (arg === "--reason") reason = args[++i];
    else if (arg === "--actor") actor = args[++i];
    else return { error: `unknown argument: ${arg}` };
  }

  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "--repo owner/repo is required" };
  if (issue === undefined || !Number.isInteger(issue)) {
    return { error: "--issue <number> is required" };
  }
  return { repo, issue, reason, actor };
}

/**
 * The contract an operator scripts against.
 *
 * 0 means the claim is gone AND the ticket was reconciled. 2 means the ledger let go but the ticket still lies —
 * a distinct code, because a partial outcome must not read as a clean one in a script.
 */
export function exitCodeFor(report: RetireReport): number {
  if (report.outcome === "retired") return 0;
  if (report.outcome === "retired-unreconciled") return 2;
  return 1;
}

async function main(): Promise<number> {
  const parsed = parseRetireArgs(process.argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  loadLocalEnv(process.cwd());
  const env = process.env;
  const token = resolveIssueToken(env);
  const store = createRunHistoryStore(env);

  // Without a token the LEDGER can still be retired; the ticket simply cannot be reconciled, and the report says so
  // rather than pretending. A retirement is worth having even then.
  const labels = token
    ? createGitHubLabelWriter(new GitHubIssueWriter({ token }))
    : undefined;

  const report = await retireStaleClaim(
    labels ? { store, labels } : { store },
    parsed,
  );

  process.stdout.write(`Dark Factory — retire a stale claim (${report.repo}#${report.issue})\n\n`);
  for (const line of report.lines) process.stdout.write(`  ${line}\n`);
  if (!token) {
    process.stdout.write(
      "\n  (no GitHub token was present, so the ticket's labels could not be reconciled.)\n",
    );
  }
  process.stdout.write(`\noutcome: ${report.outcome}\n`);

  await store.close();
  return exitCodeFor(report);
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(
        `df:retire-claim failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
