/**
 * Dark Factory — WorkerReporter (#162): worker progress, completion and
 * questions on the issue ticket itself.
 *
 * Before this, an autonomous run was SILENT on the ticket it was working on: a
 * worker's progress reached only `DispatchObserver` → `MetricsStore` (#140),
 * which is a sensor, not a human-facing channel. Operators had to read container
 * logs to tell whether a run was progressing, finished, or stuck waiting on them.
 *
 * SECURITY SHAPE — why the reporter lives here and not in the worker:
 * it runs TRUSTED-SIDE in Eve's process. The sandbox's environment is scrubbed by
 * `tester-agent`'s `ALLOWED_ENV_KEYS`, and the token this module holds is never
 * passed to a `WorkerTask`, so "the sandbox holds no repository credential" is
 * true by construction rather than by care. The worker EMITS; Eve posts.
 *
 * NOISE SHAPE — one rolling comment per run, idempotent by `(runId, kind)`:
 * the posted comment ids persist in the `StateStore` under `reporter:${runId}`
 * (mirroring `dispatchKey`), so a retried or re-delivered emission EDITS the
 * recorded comment. A 10-iteration task cannot spam a ticket, and a re-delivery
 * cannot pile up duplicates — the failure mode this repo has been bitten by.
 *
 * FAIL-CLOSED: with no provider configured the default is the console/dry-run
 * provider and NOTHING is written; a repo outside `resolveWorkerAllowedRepos()`
 * is refused before any call is made. An unconfigured deployment writes nothing.
 */
import { resolveWorkerAllowedRepos } from "./credentials";
import {
  GitHubIssueWriter,
  resolveIssueToken,
  type IssueWriterFetch,
} from "./issue-writer";
import type { RunHistoryStore } from "./run-history-store";
import { toRunEvent } from "./run-history";
import type { StateReadResult, StateStore } from "./state";

export type WorkerMessageKind = "progress" | "completed" | "question";

/** Canonical, provider-agnostic report from a worker. Fields, not free prose. */
export interface WorkerMessage {
  kind: WorkerMessageKind;
  runId: string;
  /** Normalised `owner/repo` the run belongs to. */
  repo: string;
  issue: number;
  /** Stable lifecycle-event identity and source time, required when run history is enabled. */
  eventId?: string;
  occurredAt?: string;
  /** progress: which iteration this is, and the budget. */
  attempt?: number;
  maxAttempts?: number;
  /** completed: how the run ended. */
  outcome?: "pass" | "fail";
  /** completed: test evidence (bounded, never a raw dump). */
  failures?: string[];
  /** question: what the run needs a human to decide. */
  question?: string;
}

export class InvalidWorkerMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkerMessageError";
  }
}

/** Bounds, so a worker cannot post an unbounded wall of text (or a huge number). */
export const MAX_QUESTION_CHARS = 2000;
export const MAX_TEST_EVIDENCE_LINES = 20;
export const MAX_TEST_EVIDENCE_CHARS = 300;
export const MAX_ATTEMPT = 1000;

const REPO_PAIR_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const KINDS: WorkerMessageKind[] = ["progress", "completed", "question"];

function positiveInt(value: unknown, field: string): number {
  if (
    !Number.isInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAX_ATTEMPT
  ) {
    throw new InvalidWorkerMessageError(
      `Worker message requires "${field}" to be an integer in [1, ${MAX_ATTEMPT}] ` +
        `(received ${JSON.stringify(value)}).`,
    );
  }
  return value as number;
}

/**
 * Validate and normalise a report. Invalid input THROWS (a caller bug — the
 * contract was violated) rather than being posted in a half-formed state, which
 * matches `toDispatchEvent`/`toTaskMetric` and keeps the checks in one place.
 */
export function toWorkerMessage(input: Partial<WorkerMessage>): WorkerMessage {
  const kind = input.kind;
  if (!KINDS.includes(kind as WorkerMessageKind)) {
    throw new InvalidWorkerMessageError(
      `Worker message requires "kind" to be one of ${KINDS.join(", ")} (received ${JSON.stringify(kind)}).`,
    );
  }
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  if (!runId) {
    throw new InvalidWorkerMessageError(
      `Worker message requires a non-empty "runId" (received ${JSON.stringify(input.runId)}).`,
    );
  }
  const repo =
    typeof input.repo === "string" ? input.repo.trim().toLowerCase() : "";
  if (!REPO_PAIR_PATTERN.test(repo)) {
    throw new InvalidWorkerMessageError(
      `Worker message requires "repo" to be an owner/repo pair (received ${JSON.stringify(input.repo)}).`,
    );
  }
  if (!Number.isInteger(input.issue) || (input.issue as number) <= 0) {
    throw new InvalidWorkerMessageError(
      `Worker message requires a positive "issue" number (received ${JSON.stringify(input.issue)}).`,
    );
  }

  const message: WorkerMessage = {
    kind: kind as WorkerMessageKind,
    runId,
    repo,
    issue: input.issue as number,
  };

  if (input.eventId !== undefined) {
    const eventId = typeof input.eventId === "string" ? input.eventId.trim() : "";
    if (
      !eventId ||
      eventId.length > 256 ||
      [...eventId].some((ch) => {
        const code = ch.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      throw new InvalidWorkerMessageError("Worker message eventId must be a valid non-empty identifier.");
    }
    message.eventId = eventId;
  }
  if (input.occurredAt !== undefined) {
    const time = typeof input.occurredAt === "string" ? Date.parse(input.occurredAt) : Number.NaN;
    if (!Number.isFinite(time)) {
      throw new InvalidWorkerMessageError("Worker message occurredAt must be a valid timestamp.");
    }
    message.occurredAt = new Date(time).toISOString();
  }

  if (input.attempt !== undefined)
    message.attempt = positiveInt(input.attempt, "attempt");
  if (input.maxAttempts !== undefined) {
    message.maxAttempts = positiveInt(input.maxAttempts, "maxAttempts");
  }
  if (
    message.attempt !== undefined &&
    message.maxAttempts !== undefined &&
    message.attempt > message.maxAttempts
  ) {
    throw new InvalidWorkerMessageError(
      `Worker message requires "attempt" <= "maxAttempts" (received ${message.attempt} > ${message.maxAttempts}).`,
    );
  }

  if (message.kind === "completed") {
    if (input.outcome !== "pass" && input.outcome !== "fail") {
      throw new InvalidWorkerMessageError(
        `A "completed" message requires "outcome" to be "pass" or "fail" (received ${JSON.stringify(input.outcome)}).`,
      );
    }
    message.outcome = input.outcome;
    const failures = Array.isArray(input.failures) ? input.failures : [];
    if (failures.length > MAX_TEST_EVIDENCE_LINES) {
      throw new InvalidWorkerMessageError(
        `A "completed" message allows at most ${MAX_TEST_EVIDENCE_LINES} test-evidence lines ` +
          `(received ${failures.length}).`,
      );
    }
    message.failures = failures.map((line) => {
      const text = typeof line === "string" ? line.trim() : "";
      if (text.length > MAX_TEST_EVIDENCE_CHARS) {
        throw new InvalidWorkerMessageError(
          `A test-evidence line may be at most ${MAX_TEST_EVIDENCE_CHARS} characters.`,
        );
      }
      return text;
    });
  }

  if (message.kind === "question") {
    const question =
      typeof input.question === "string" ? input.question.trim() : "";
    if (!question) {
      throw new InvalidWorkerMessageError(
        'A "question" message requires non-empty "question" text.',
      );
    }
    if (question.length > MAX_QUESTION_CHARS) {
      throw new InvalidWorkerMessageError(
        `A "question" may be at most ${MAX_QUESTION_CHARS} characters (received ${question.length}).`,
      );
    }
    message.question = question;
  }

  return message;
}

/** Canonical store key for a run's posted comments, mirroring `dispatchKey`. */
export function reporterKey(runId: string): string {
  return `reporter:${runId}`;
}

interface ReporterRecord {
  commentIds: Partial<Record<WorkerMessageKind, number>>;
}

/**
 * Render a report for a ticket. Attributed to **Eve** — the orchestrator — never
 * to the sandboxed worker, which must not appear to be the author of anything.
 */
export function renderMessage(message: WorkerMessage): string {
  const where = `${message.repo}#${message.issue}`;
  if (message.kind === "progress") {
    const budget =
      message.attempt !== undefined && message.maxAttempts !== undefined
        ? `${message.attempt}/${message.maxAttempts}`
        : `${message.attempt ?? "?"}`;
    return `🤖 **Eve** (Dark Factory) — progress on ${where}\n\nAttempt **${budget}** in flight.`;
  }
  if (message.kind === "completed") {
    const verdict =
      message.outcome === "pass" ? "passed ✅" : "terminal failure ❌";
    const evidence = (message.failures ?? []).filter(Boolean);
    const lines = [
      `🤖 **Eve** (Dark Factory) — run ${verdict} on ${where}`,
      "",
    ];
    if (message.attempt !== undefined)
      lines.push(`Attempts used: **${message.attempt}**`);
    if (evidence.length > 0) {
      lines.push(
        "",
        "Test evidence:",
        ...evidence.map((line) => `- \`${line}\``),
      );
    }
    return lines.join("\n");
  }
  return (
    `🤖 **Eve** (Dark Factory) — this run is **blocked on a human decision** (${where})\n\n` +
    `${message.question}\n\n` +
    "_Reply here and the run resumes; it will not consume further iterations while it waits._"
  );
}

export interface ReportResult {
  ok: boolean;
  mode: "live" | "dry-run" | "blocked";
  providerId: string;
  commentId?: number;
  /** True when this emission updated the recorded comment instead of posting. */
  edited?: boolean;
  error?: string;
}

export interface WorkerReporter {
  id: string;
  mode: "live" | "dry-run";
  report(message: WorkerMessage): Promise<ReportResult>;
}

/** The fail-closed default: renders locally, writes nothing, needs no token. */
export class ConsoleReporter implements WorkerReporter {
  id = "console";
  mode = "dry-run" as const;

  async report(message: WorkerMessage): Promise<ReportResult> {
    const valid = toWorkerMessage(message);
    console.log(`[df-reporter:console] ${renderMessage(valid)}`);
    return { ok: true, mode: "dry-run", providerId: this.id };
  }
}

class RunHistoryWorkerReporter implements WorkerReporter {
  readonly id: string;
  readonly mode: "live" | "dry-run";

  constructor(
    private readonly inner: WorkerReporter,
    private readonly runHistory: RunHistoryStore,
  ) {
    this.id = inner.id;
    this.mode = inner.mode;
  }

  async report(message: WorkerMessage): Promise<ReportResult> {
    const valid = toWorkerMessage(message);
    if (!valid.eventId || !valid.occurredAt) {
      throw new InvalidWorkerMessageError(
        "Worker message eventId and occurredAt are required when run-history persistence is enabled.",
      );
    }

    const event = toRunEvent({
      eventId: valid.eventId,
      runId: valid.runId,
      type:
        valid.kind === "progress"
          ? "worker.progress"
          : valid.kind === "completed"
            ? "worker.completed"
            : "worker.question",
      stage: "worker",
      occurredAt: valid.occurredAt,
      status: valid.kind === "question" ? "blocked" : "running",
      ...(valid.attempt !== undefined ? { iterationCount: valid.attempt } : {}),
    });

    try {
      const persisted = await this.runHistory.appendEvent(event);
      if (!persisted.ok) {
        return {
          ok: false,
          mode: "blocked",
          providerId: this.id,
          error: persisted.error ?? "Run history refused the worker event.",
        };
      }
    } catch (err) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error: `Run history write failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return this.inner.report(valid);
  }
}

export interface GitHubCommentReporterOptions {
  store: StateStore;
  /** Defaults to `resolveIssueToken()`; absent means no write is possible. */
  token?: string;
  /**
   * Defaults to `resolveWorkerAllowedRepos()` — the SAME list that governs which
   * repos a worker may touch, so there is no state where a worker works on a repo
   * Eve refuses to comment on. Unset ⇒ `[]` ⇒ everything refused.
   */
  allowedRepos?: string[];
  fetchImpl?: IssueWriterFetch;
}

/**
 * Posts (and edits) the ticket comments. Holds the credential in the
 * orchestrator's process and refuses anything outside the allow-list before it
 * makes a call.
 */
export class GitHubCommentReporter implements WorkerReporter {
  id = "github";
  mode = "live" as const;

  private readonly store: StateStore;
  private readonly allowedRepos: string[];
  private readonly writer: GitHubIssueWriter;

  constructor(options: GitHubCommentReporterOptions) {
    this.store = options.store;
    this.allowedRepos = (
      options.allowedRepos ?? resolveWorkerAllowedRepos()
    ).map((entry) => entry.trim().toLowerCase());
    this.writer = new GitHubIssueWriter({
      token: options.token,
      fetchImpl: options.fetchImpl,
    });
  }

  async report(message: WorkerMessage): Promise<ReportResult> {
    const valid = toWorkerMessage(message);

    // Fail-closed BEFORE any I/O: an off-list repo is refused, never "widened".
    if (!this.allowedRepos.includes(valid.repo)) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error:
          `Repo '${valid.repo}' is not in the worker allow-list [${this.allowedRepos.join(", ")}]. ` +
          "Refusing to write; set DF_WORKER_ALLOWED_REPOS to include it.",
      };
    }

    const body = renderMessage(valid);
    const [owner, repoName] = valid.repo.split("/");
    const loaded = await this.readRecord(valid.runId);
    if (!loaded.ok) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error: loaded.error,
      };
    }
    const record = loaded.record;
    const recorded = record.commentIds[valid.kind];

    if (recorded !== undefined) {
      const edited = await this.writer.editComment(
        owner,
        repoName,
        recorded,
        body,
      );
      if (!edited.ok) {
        return {
          ok: false,
          mode: "live",
          providerId: this.id,
          error: edited.error,
        };
      }
      return {
        ok: true,
        mode: "live",
        providerId: this.id,
        commentId: recorded,
        edited: true,
      };
    }

    const posted = await this.writer.postComment(
      owner,
      repoName,
      valid.issue,
      body,
    );
    if (!posted.ok || posted.id === undefined) {
      return {
        ok: false,
        mode: "live",
        providerId: this.id,
        error: posted.error ?? "GitHub did not return a comment id",
      };
    }
    const saved = await this.writeRecord(valid.runId, {
      commentIds: { ...record.commentIds, [valid.kind]: posted.id },
    });
    if (!saved.ok) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        commentId: posted.id,
        error:
          "The GitHub comment was posted, but its idempotency record could not be persisted.",
      };
    }
    return {
      ok: true,
      mode: "live",
      providerId: this.id,
      commentId: posted.id,
      edited: false,
    };
  }

  /** A missing key is empty state; an unreadable key is an operational failure. */
  private async readRecord(
    runId: string,
  ): Promise<{ ok: true; record: ReporterRecord } | { ok: false; error: string }> {
    let read: StateReadResult<ReporterRecord>;
    try {
      read = await this.store.get<ReporterRecord>(reporterKey(runId));
    } catch {
      return { ok: false, error: `Cannot read reporter state from '${this.store.id}'.` };
    }
    if (!read.ok) {
      return { ok: false, error: `Cannot read reporter state from '${this.store.id}'.` };
    }
    if (read.value === null) return { ok: true, record: { commentIds: {} } };
    if (
      typeof read.value !== "object" ||
      read.value === null ||
      typeof read.value.commentIds !== "object" ||
      read.value.commentIds === null
    ) {
      return { ok: false, error: "Reporter state is malformed; refusing to post a duplicate comment." };
    }
    for (const [kind, id] of Object.entries(read.value.commentIds)) {
      if (
        !KINDS.includes(kind as WorkerMessageKind) ||
        !Number.isSafeInteger(id) ||
        (id as number) <= 0
      ) {
        return { ok: false, error: "Reporter state is malformed; refusing to post a duplicate comment." };
      }
    }
    return { ok: true, record: { commentIds: { ...read.value.commentIds } } };
  }

  private async writeRecord(
    runId: string,
    record: ReporterRecord,
  ): Promise<{ ok: boolean }> {
    try {
      const saved = await this.store.save(reporterKey(runId), record);
      return saved.ok
        ? { ok: true }
        : { ok: false };
    } catch {
      return { ok: false };
    }
  }
}

/**
 * Choose the reporter from the environment.
 *
 * Fail-closed: anything other than an explicit `github` selection is the
 * console/dry-run provider, so a deployment that forgets to configure a provider
 * posts NOTHING rather than guessing.
 */
export function createWorkerReporter(
  env: Record<string, string | undefined> = process.env,
  deps: {
    store?: StateStore;
    runHistory?: RunHistoryStore;
    fetchImpl?: IssueWriterFetch;
  } = {},
): WorkerReporter {
  const driver = (env.DF_REPORTER_PROVIDER ?? "").trim().toLowerCase();
  const reporter =
    driver === "github" && deps.store
      ? new GitHubCommentReporter({
          store: deps.store,
          token: resolveIssueToken(env),
          allowedRepos: resolveWorkerAllowedRepos(env),
          fetchImpl: deps.fetchImpl,
        })
      : new ConsoleReporter();
  return deps.runHistory
    ? new RunHistoryWorkerReporter(reporter, deps.runHistory)
    : reporter;
}
