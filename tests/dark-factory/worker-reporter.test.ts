/**
 * #162 — WorkerReporter: progress, completion and questions on the ticket.
 *
 * The security shape these tests exist to hold: the reporter runs TRUSTED-SIDE
 * (Eve's process), the worker never holds a token, and a repo outside the
 * fail-closed allow-list is refused before anything is written. And the noise
 * shape: one rolling comment per run, idempotent by `(runId, kind)` — a retried
 * emission EDITS, it never duplicates.
 */
import { describe, it, expect } from "vitest";
import {
  toWorkerMessage,
  InvalidWorkerMessageError,
  ConsoleReporter,
  GitHubCommentReporter,
  createWorkerReporter,
  renderMessage,
  MAX_ATTEMPT,
  type WorkerMessage,
} from "../../agent/lib/dark-factory/worker-reporter";
import { ALLOWED_ENV_KEYS } from "../../agent/lib/dark-factory/tester-agent";
import type {
  StateReadResult,
  StateStore,
  StateWriteResult,
} from "../../agent/lib/dark-factory/state";

/** Minimal in-memory StateStore: the idempotence record is all we persist. */
class MemoryStore implements StateStore {
  id = "memory";
  private readonly data = new Map<string, unknown>();
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
  raw(key: string): unknown {
    return this.data.get(key);
  }
}

/** Records every HTTP call, so POST-vs-PATCH counts are assertable. */
function fakeFetch() {
  const calls: {
    method: string;
    url: string;
    body: Record<string, unknown> | undefined;
  }[] = [];
  const impl = (async (
    url: unknown,
    init: { method?: string; body?: string } = {},
  ) => {
    const method = init.method ?? "GET";
    calls.push({
      method,
      url: String(url),
      body: init.body
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined,
    });
    return {
      ok: true,
      status: method === "POST" ? 201 : 200,
      json: async () => ({ id: 5000 + calls.length }),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ALLOWED = ["ricardoblackskye/agent-eve"];
const TOKEN = "ghp_test_token_value";

const msg = (over: Partial<WorkerMessage> = {}): WorkerMessage => ({
  kind: "progress",
  runId: "run-1",
  repo: "ricardoblackskye/agent-eve",
  issue: 162,
  attempt: 1,
  maxAttempts: 3,
  ...over,
});

function makeReporter(
  over: { store?: MemoryStore; allowed?: string[]; token?: string } = {},
) {
  const store = over.store ?? new MemoryStore();
  const { impl, calls } = fakeFetch();
  const subject = new GitHubCommentReporter({
    store,
    allowedRepos: over.allowed ?? ALLOWED,
    token: over.token ?? TOKEN,
    fetchImpl: impl,
  });
  return { subject, store, calls };
}

describe("#162 cycle 1-2: the payload is canonical and validated", () => {
  it("accepts the three kinds and normalises the repo", () => {
    const m = toWorkerMessage(msg({ repo: "RicardoBlackSkye/Agent-Eve" }));
    expect(m.kind).toBe("progress");
    expect(m.repo).toBe("ricardoblackskye/agent-eve");
  });

  it.each([
    [
      "an unknown kind",
      { kind: "chatter" as unknown as WorkerMessage["kind"] },
    ],
    ["a missing runId", { runId: "" }],
    ["a missing repo", { repo: "" }],
    ["a repo that is not owner/repo", { repo: "just-a-name" }],
    ["a non-positive issue", { issue: 0 }],
  ])("refuses %s", (_label, over) => {
    expect(() => toWorkerMessage({ ...msg(), ...over })).toThrow(
      InvalidWorkerMessageError,
    );
  });

  it("refuses a question kind with no question text", () => {
    expect(() => toWorkerMessage(msg({ kind: "question" }))).toThrow(
      /question/,
    );
  });

  it("refuses an absurd or negative attempt (bounded, like every other number)", () => {
    expect(() => toWorkerMessage(msg({ attempt: -1 }))).toThrow(
      InvalidWorkerMessageError,
    );
    expect(() => toWorkerMessage(msg({ attempt: 1e9 }))).toThrow(
      InvalidWorkerMessageError,
    );
    expect(() => toWorkerMessage(msg({ attempt: 2, maxAttempts: 1 }))).toThrow(
      /maxAttempts/,
    );
  });

  it("accepts exactly MAX evidence lines and refuses one more (length is a count, not an index)", () => {
    const atBound = Array.from({ length: 20 }, (_, i) => `t${i}.test.ts:1`);
    expect(
      toWorkerMessage(
        msg({ kind: "completed", outcome: "fail", failures: atBound }),
      ).failures,
    ).toHaveLength(20);
    expect(() =>
      toWorkerMessage(
        msg({
          kind: "completed",
          outcome: "fail",
          failures: [...atBound, "one-more.test.ts:1"],
        }),
      ),
    ).toThrow(InvalidWorkerMessageError);
  });

  it("accepts the bound ITSELF — the range is inclusive, not off by one", () => {
    const atBound = toWorkerMessage(
      msg({ attempt: MAX_ATTEMPT, maxAttempts: MAX_ATTEMPT }),
    );
    expect(atBound.attempt).toBe(MAX_ATTEMPT);
    expect(() =>
      toWorkerMessage(
        msg({ attempt: MAX_ATTEMPT + 1, maxAttempts: MAX_ATTEMPT }),
      ),
    ).toThrow(InvalidWorkerMessageError);
  });

  it("renders a completed report with its outcome, attempts and evidence", () => {
    const body = renderMessage(
      toWorkerMessage(
        msg({
          kind: "completed",
          outcome: "fail",
          attempt: 4,
          maxAttempts: 4,
          failures: ["a.test.ts:1 boom"],
        }),
      ),
    );
    expect(body).toMatch(/terminal failure/i);
    expect(body).toMatch(/Attempts used: \*\*4\*\*/);
    expect(body).toMatch(/a\.test\.ts:1 boom/);
  });

  it("refuses over-long text rather than posting it", () => {
    expect(() =>
      toWorkerMessage(msg({ kind: "question", question: "x".repeat(5000) })),
    ).toThrow(InvalidWorkerMessageError);
  });
});

describe("#162 cycle 3-4: the default is console and writes NOTHING", () => {
  it("renders every kind without touching the network", async () => {
    const reporter = new ConsoleReporter();
    expect(reporter.mode).toBe("dry-run");
    for (const m of [
      msg(),
      msg({ kind: "completed", outcome: "pass", failures: [] }),
      msg({ kind: "question", question: "Which branch?" }),
    ]) {
      const res = await reporter.report(m);
      expect(res.ok).toBe(true);
      expect(res.mode).toBe("dry-run");
    }
  });

  it("createWorkerReporter with no configuration returns the console provider", async () => {
    const reporter = createWorkerReporter({});
    expect(reporter.id).toBe("console");
    expect(reporter.mode).toBe("dry-run");
  });

  it("a GitHub reporter with NO allow-list configured refuses every repo (fail-closed)", async () => {
    const { subject, calls } = makeReporter({ allowed: [] });
    const res = await subject.report(msg());
    expect(res.ok).toBe(false);
    expect(res.mode).toBe("blocked");
    expect(res.error).toMatch(/allow-list/i);
    expect(calls).toHaveLength(0); // nothing was written
  });
});

describe("#162 cycle 5-6: the allow-list gate reuses the worker policy", () => {
  it("refuses a repo outside the allow-list, writing nothing", async () => {
    const { subject, calls } = makeReporter();
    const res = await subject.report(msg({ repo: "other-org/other-repo" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/other-org\/other-repo/);
    expect(calls).toHaveLength(0);
  });

  it("agrees with resolveWorkerAllowedRepos: unset means refuse", async () => {
    const { resolveWorkerAllowedRepos } =
      await import("../../agent/lib/dark-factory/credentials");
    expect(resolveWorkerAllowedRepos({})).toEqual([]);
    const { subject } = makeReporter({
      allowed: resolveWorkerAllowedRepos({}),
    });
    expect((await subject.report(msg())).ok).toBe(false);
  });
});

describe("#162 cycle 7-10: idempotent by (runId, kind) — edit, never duplicate", () => {
  it("POSTs on the first emission and records the comment id against the run", async () => {
    const { subject, store, calls } = makeReporter();
    const res = await subject.report(msg());
    expect(res.ok).toBe(true);
    expect(res.commentId).toBeGreaterThan(0);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(store.raw("reporter:run-1")).toBeTruthy();
  });

  it("EDITS the recorded comment when the same (runId, kind) is re-emitted", async () => {
    const { subject, calls } = makeReporter();
    const first = await subject.report(msg({ attempt: 1 }));
    const second = await subject.report(msg({ attempt: 2 }));
    expect(second.commentId).toBe(first.commentId);
    expect(second.edited).toBe(true);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("keeps ONE rolling progress comment across many iterations", async () => {
    const { subject, calls } = makeReporter();
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await subject.report(msg({ attempt, maxAttempts: 10 }));
    }
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(9);
  });

  it("gives each kind its own comment, each independently idempotent", async () => {
    const { subject, calls } = makeReporter();
    await subject.report(msg());
    await subject.report(
      msg({ kind: "completed", outcome: "pass", failures: [] }),
    );
    await subject.report(msg({ kind: "question", question: "Which branch?" }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(3);
    await subject.report(
      msg({ kind: "completed", outcome: "fail", failures: ["x.test.ts:1"] }),
    );
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(3);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });

  it("survives a FRESH reporter over the same store — edit, not a second comment", async () => {
    const store = new MemoryStore();
    const first = makeReporter({ store });
    const created = await first.subject.report(msg());
    const second = makeReporter({ store });
    const updated = await second.subject.report(msg({ attempt: 3 }));
    expect(updated.commentId).toBe(created.commentId);
    expect(second.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(second.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  });
});

describe("#162 cycle 14-15: attribution and the credential boundary", () => {
  it("attributes the comment to Eve, never to the sandboxed worker", async () => {
    const { subject, calls } = makeReporter();
    await subject.report(msg({ kind: "question", question: "Which branch?" }));
    const body = String(calls[0].body?.body ?? "");
    expect(body).toMatch(/Eve/i);
    expect(body).not.toMatch(/worker W\d/i);
  });

  it("never exposes the token in a rendered body or an error", async () => {
    const { subject, calls } = makeReporter();
    await subject.report(msg());
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
    const refused = await makeReporter({
      allowed: ["other/repo"],
    }).subject.report(msg());
    expect(String(refused.error)).not.toContain(TOKEN);
  });

  it("keeps every token the reporter reads out of the worker environment", () => {
    // The reporter reads these; they must all be absent from the scrubbed env —
    // that is what makes "the sandbox holds no credential" true by construction.
    for (const key of ["GH_STORY_TOKEN", "GH_RELEASE_TOKEN", "GITHUB_TOKEN"]) {
      expect(ALLOWED_ENV_KEYS.has(key)).toBe(false);
    }
  });
});
