/**
 * #162 — local evidence run (NOT part of the test suite).
 *
 * Proves, on this laptop, the three things the issue's ACs turn on:
 *   1. all three kinds render through the console/dry-run provider, writing nothing;
 *   2. a recording provider shows a rolling progress comment (1 POST, then PATCHes),
 *      an edit-not-duplicate re-delivery, and an off-allow-list repo REFUSED with
 *      no call at all;
 *   3. the recorded comment ids survive a FRESH PROCESS over a real SQLite store —
 *      process 2 EDITS the comment process 1 created.
 *
 * Run: npx tsx scripts/worker-reporter-demo.local.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStateAdapter } from "../agent/lib/dark-factory/state";
import { resolveWorkerAllowedRepos } from "../agent/lib/dark-factory/credentials";
import {
  ConsoleReporter,
  GitHubCommentReporter,
  reporterKey,
  toWorkerMessage,
} from "../agent/lib/dark-factory/worker-reporter";

const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(30)} ${JSON.stringify(value)}`);
const ALLOWED = ["ricardoblackskye/agent-eve"];

/** Records every call, so POST-vs-PATCH counts and refusals are provable. */
function recordingFetch() {
  const calls: { method: string; url: string; body: string }[] = [];
  const impl = (async (url: unknown, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url: String(url), body: String(init.body ?? "") });
    return {
      ok: true,
      status: method === "POST" ? 201 : 200,
      // Distinct ids, like the real API: a single constant would hide which
      // comment an edit actually targeted.
      json: async () => ({ id: 9000 + calls.length }),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const msg = (over: Record<string, unknown> = {}) =>
  toWorkerMessage({
    kind: "progress",
    runId: "run-demo-162",
    repo: "ricardoblackskye/agent-eve",
    issue: 162,
    attempt: 1,
    maxAttempts: 10,
    ...over,
  });

async function part1Console(): Promise<void> {
  console.log("[1] CONSOLE / DRY-RUN provider — all three kinds, nothing written");
  const reporter = new ConsoleReporter();
  for (const m of [
    msg({ attempt: 3, maxAttempts: 10 }),
    msg({ kind: "completed", outcome: "pass", failures: ["tests/foo.test.ts:12 expected 1 to be 2"] }),
    msg({ kind: "question", question: "Should the retry budget be raised for this task type?" }),
  ]) {
    const res = await reporter.report(m);
    line(`  ${m.kind} →`, { ok: res.ok, mode: res.mode, wrote: false });
  }
  console.log();
}

async function part2RollingAndGate(): Promise<void> {
  console.log("[2] GITHUB provider (recording) — one rolling comment, edits not duplicates");
  const store = new SqliteStateAdapter(join(SQLITE_DIR, "reporter.sqlite"));
  const { impl, calls } = recordingFetch();
  const reporter = new GitHubCommentReporter({
    store,
    token: "demo-token-not-a-real-secret",
    allowedRepos: ALLOWED,
    fetchImpl: impl,
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) await reporter.report(msg({ attempt }));
  line("progress x3", {
    POST: calls.filter((c) => c.method === "POST").length,
    PATCH: calls.filter((c) => c.method === "PATCH").length,
  });

  await reporter.report(msg({ kind: "question", question: "Raise the retry budget?" }));
  await reporter.report(msg({ kind: "question", question: "Raise the retry budget?" }));
  line("question x2 (re-delivered)", {
    POST: calls.filter((c) => c.method === "POST").length,
    PATCH: calls.filter((c) => c.method === "PATCH").length,
  });

  const refused = await reporter.report(msg({ repo: "other-org/other-repo" }));
  line("off-allow-list repo", { ok: refused.ok, mode: refused.mode });
  line("calls made for the refusal", calls.filter((c) => c.url.includes("other-org")).length);
  store.close();
  console.log();
}

async function part3FreshProcess(): Promise<void> {
  console.log("[3] FRESH PROCESS over the same SQLite store — durability, not a memory");
  const db = join(SQLITE_DIR, "reporter.sqlite");
  const script = process.argv[1];
  // The db path is an argv handoff, not configuration: it must not be an env
  // var, because every env var the source references is expected to be
  // user-settable and documented in .env.example (tests/env-example-coverage).
  const child = execFileSync(process.execPath, ["--import", "tsx", script, "--fresh", db], {
    encoding: "utf8",
  });
  process.stdout.write(child);
}

/** Child mode: a NEW process reads the ids process 2 left behind. */
async function childMode(): Promise<void> {
  const store = new SqliteStateAdapter(process.argv[process.argv.length - 1]);
  const read = await store.get(reporterKey("run-demo-162"));
  line("ids read back", (read.value as { commentIds?: unknown } | null)?.commentIds ?? null);
  const { impl, calls } = recordingFetch();
  const reporter = new GitHubCommentReporter({
    store,
    token: "demo-token-not-a-real-secret",
    allowedRepos: ALLOWED,
    fetchImpl: impl,
  });
  await reporter.report(msg({ attempt: 9 }));
  line("fresh-process emission", {
    POST: calls.filter((c) => c.method === "POST").length,
    PATCH: calls.filter((c) => c.method === "PATCH").length,
  });
  store.close();
}

const SQLITE_DIR = mkdtempSync(join(tmpdir(), "df-reporter-demo-"));

async function main(): Promise<void> {
  if (process.argv.includes("--fresh")) {
    console.log("  (child process, separate node process, same SQLite file)");
    await childMode();
    return;
  }

  console.log(`allow-list in force: ${JSON.stringify(resolveWorkerAllowedRepos({ DF_WORKER_ALLOWED_REPOS: ALLOWED.join(",") }))}\n`);
  await part1Console();
  await part2RollingAndGate();
  await part3FreshProcess();

  // Windows: the SQLite handle must be closed before the temp dir can go.
  if (existsSync(SQLITE_DIR)) rmSync(SQLITE_DIR, { recursive: true, force: true });
}

void main();
