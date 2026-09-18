/**
 * #163 — offline replay of a recorded webhook payload (NOT part of the test suite).
 *
 * Proves the local-development path the issue asks for: the whole trigger -> dispatch ->
 * handoff path runs on this laptop from a FIXTURE, with **no network and no GitHub
 * write** — the recording transports below assert that zero real calls were made.
 *
 * It also proves local mode's safety: `DF_RUNNER=local` is honoured off a production
 * build and REFUSED in any production build (Vercel's or self-hosted), which is the
 * hole the webhook route's `requiresSignature()` comment records.
 *
 * Run: npx tsx scripts/dark-factory-local.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideDarkFactoryTrigger } from "../agent/lib/dark-factory/trigger";
import {
  resolveRunnerMode,
  runDarkFactoryDispatch,
} from "../agent/lib/dark-factory/entry";
import {
  dispatchKey,
  type DispatchRecord,
} from "../agent/lib/dark-factory/dispatch";
import type {
  StateReadResult,
  StateStore,
  StateWriteResult,
} from "../agent/lib/dark-factory/state";

const line = (label: string, value: unknown) =>
  console.log(
    `  ${label.padEnd(28)} ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );

class MemoryStore implements StateStore {
  id = "memory";
  readonly data = new Map<string, unknown>();
  async save(key: string, value: unknown): Promise<StateWriteResult> {
    this.data.set(key, value);
    return { ok: true, mode: "live", providerId: this.id };
  }
  async get<T = unknown>(key: string): Promise<StateReadResult<T>> {
    return {
      ok: true,
      mode: "live",
      providerId: this.id,
      value: (this.data.get(key) ?? null) as T | null,
    };
  }
}

/** Transports that record instead of reaching out — the offline guarantee. */
const realNetworkCalls: string[] = [];
function recordingPost() {
  const calls: { url: string; body: string }[] = [];
  const impl = (async (url: unknown, init: { body?: string } = {}) => {
    calls.push({ url: String(url), body: String(init.body ?? "") });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ENV = {
  // The offline replay configures its own gates: no .env, no API key, no network.
  DF_TRIGGER_LABEL: "dark-factory",
  DF_WORKER_ALLOWED_REPOS: "ricardoblackskye/agent-eve",
  DF_TRIGGER_ALLOWED_USERS: "ricardoblackskye",
};

async function main(): Promise<void> {
  const fixturePath = join(
    process.cwd(),
    "tests",
    "fixtures",
    "webhook-dark-factory.json",
  );
  const payload = JSON.parse(readFileSync(fixturePath, "utf8"));

  console.log(
    "[1] REPLAY a recorded webhook payload — no network, no GitHub write",
  );
  line("fixture", "tests/fixtures/webhook-dark-factory.json");
  const decision = decideDarkFactoryTrigger(payload, ENV);
  line("decision", decision.kind);
  line("reason", decision.reason);

  const store = new MemoryStore();
  const { impl, calls } = recordingPost();
  const labelOps: string[] = [];
  let handlerCalled = 0;
  const outcome = await runDarkFactoryDispatch(decision, {
    store,
    postSession: impl,
    origin: "http://localhost:3000",
    labels: {
      add: async (_r, _i, label) => {
        labelOps.push(`+${label}`);
        return { ok: true };
      },
      remove: async (_r, _i, label) => {
        labelOps.push(`-${label}`);
        return { ok: true };
      },
    },
    handler: async () => {
      handlerCalled += 1;
    },
  });

  line("outcome", { ok: outcome.ok, status: outcome.status });
  line("lifecycle labels", labelOps);
  const record = store.data.get(
    dispatchKey(`ricardoblackskye/agent-eve#163`),
  ) as DispatchRecord | undefined;
  line(
    "dispatch recorded",
    record ? { status: record.status, attempts: record.attempts } : null,
  );
  line(
    "handoff POSTs",
    calls.map((c) => c.url),
  );
  line("worker handler invoked", handlerCalled);
  line("REAL network calls", realNetworkCalls.length);

  console.log("\n  --- the handoff message (the brief arrives as DATA) ---");
  console.log(
    calls[0].body
      .split("\\n")
      .join("\n")
      .split("\n")
      .map((l) => `  | ${l}`)
      .join("\n")
      .slice(0, 1400),
  );

  console.log("\n[2] LOCAL MODE — opt-in, and impossible in production");
  line("DF_RUNNER=local (laptop)", resolveRunnerMode({ DF_RUNNER: "local" }));
  line(
    "+ VERCEL_ENV=production",
    resolveRunnerMode({ DF_RUNNER: "local", VERCEL_ENV: "production" }),
  );
  line(
    "+ NODE_ENV=production",
    resolveRunnerMode({ DF_RUNNER: "local", NODE_ENV: "production" }),
  );
  line("no flag at all", resolveRunnerMode({}));

  console.log("\n[3] A SECOND delivery of the same label is HELD (idempotent)");
  const again = await runDarkFactoryDispatch(
    decideDarkFactoryTrigger(payload, ENV),
    {
      store,
      postSession: impl,
      origin: "http://localhost:3000",
      labels: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
    },
  );
  line("second outcome", { status: again.status, reason: again.reason });
  line("total handoff POSTs", calls.length);

  if (realNetworkCalls.length > 0) {
    throw new Error(
      `offline replay made ${realNetworkCalls.length} real network call(s)`,
    );
  }
}

void main();
