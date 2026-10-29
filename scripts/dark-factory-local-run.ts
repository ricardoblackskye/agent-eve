#!/usr/bin/env tsx
/**
 * `npm run df:local-run` — the single command that provisions a local Dark Factory run (#404 R1).
 *
 * It asserts every prerequisite up front and reports them ALL at once, prepares a checkout of the TARGET
 * repository as the working directory (discovery reads process.cwd(), #405), and only then spawns the runner.
 * A park is expected: the run posts a plan and waits for approval (#378).
 *
 * Secrets are read from the environment (the agent's .env.local, loaded here) and never printed. A hosted store
 * is refused locally unless --allow-remote-store is passed (ADR 0039 governs trust).
 */
import net from "node:net";
import { join } from "node:path";
import { loadLocalEnv } from "./load-env";
import { createRunHistoryStore } from "../agent/lib/dark-factory/run-history-provider";
import {
  runLocalRun,
  defaultGitClone,
  defaultRunnerSpawn,
  type LaunchSpawn,
} from "../agent/lib/dark-factory/local-run";

interface Parsed {
  repo: string;
  issue: number;
  workspaceRoot: string;
  allowRemoteStore: boolean;
  resume: boolean;
}

function parseArgs(argv: string[]): Parsed | { error: string } {
  let repo: string | undefined;
  let issue: number | undefined;
  const fallbackRoot = join(process.cwd(), "df-workspaces");
  let workspaceRoot = process.env.DF_WORKSPACE_ROOT ?? fallbackRoot;
  let allowRemoteStore = false;
  let resume = false;

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--repo") repo = args[++i];
    else if (arg === "--issue") issue = Number(args[++i]);
    else if (arg === "--workspace-root") workspaceRoot = args[++i];
    else if (arg === "--allow-remote-store") allowRemoteStore = true;
    else if (arg === "--resume") resume = true;
    else return { error: `unknown argument: ${arg}` };
  }

  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: "--repo owner/repo is required" };
  if (issue === undefined || !Number.isInteger(issue)) {
    return { error: "--issue <number> is required" };
  }
  return { repo, issue, workspaceRoot, allowRemoteStore, resume };
}

/** TCP reachability of a store URL — a missing database is a prerequisite, not a crash. */
function tcpReachable(url: string): Promise<{ ok: boolean; error?: string }> {
  const u = new URL(url);
  const port = Number(u.port) || 5432;
  const host = u.hostname;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean, error?: string) => {
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(2000, () => done(false, "timeout"));
    socket.once("connect", () => done(true));
    socket.once("error", (err: Error) => done(false, err.message));
  });
}

/** HTTP reachability of the sandbox seam. */
async function httpReachable(endpoint: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    await fetch(`${endpoint.replace(/\/$/, "")}/health`, { signal: ac.signal });
    clearTimeout(timer);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }

  // The agent's .env.local (OPENROUTER_API_KEY, store URLs) is loaded HERE so the child inherits it; the runner
  // never has to know where it came from. This is the one place env loading happens for the launcher-driven path.
  loadLocalEnv(process.cwd());

  const probes = {
    reachStore: async (url: string) => tcpReachable(url),
    reachSandbox: async (endpoint: string) => httpReachable(endpoint),
    // #404 R2 Task 5: the claim check is WIRED, so a held claim is reported in the same one block as every other
    // prerequisite — and with the command that releases it. R1 built this probe and deliberately left it unwired.
    activeClaim: async (repo: string, issue: number) => {
      const store = createRunHistoryStore(process.env);
      try {
        const active = await store.listRuns({
          repo,
          issue,
          statuses: ["queued", "running", "blocked"],
          limit: 1,
        });
        if (!active.ok) return { ok: false, error: active.error };
        const holder = active.value?.items[0];
        return holder
          ? { ok: true, holder: { runId: holder.runId, status: holder.status } }
          : { ok: true };
      } finally {
        await store.close();
      }
    },
  };

  return runLocalRun({
    repo: parsed.repo,
    issue: parsed.issue,
    workspaceRoot: parsed.workspaceRoot,
    allowRemoteStore: parsed.allowRemoteStore,
    resume: parsed.resume,
    env: process.env,
    probes,
    gitClone: defaultGitClone,
    spawnRunner: defaultRunnerSpawn as (opts: LaunchSpawn) => Promise<{ exitCode: number; signal?: string }>,
  });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`df:local-run failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
