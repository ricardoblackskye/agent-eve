import { describe, expect, it, vi } from "vitest";
import { recordRunDiffWithOutcome } from "../../agent/lib/dark-factory/diff-capture";
import type { RunSummary } from "../../agent/lib/dark-factory/run-history";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

/**
 * #704 - the runner must capture the run's diff, and must be able to SAY what happened.
 *
 * `recordRunDiff` already does the work and is tested, but it returns `void` and no-ops on an empty diff, so a caller
 * cannot tell "recorded" from "nothing changed" from "the run has no summary to attach to". The runner has to log
 * which one happened, because a NULL `git_diff` in the ledger currently means all three at once - the fail-open shape
 * filed as #772.
 *
 * This wrapper is also where the run survives: capturing a diff is telemetry, so a failure here must be REPORTED and
 * never thrown, or a green run turns red because a diagnostic could not be written.
 */

function fakeStore(summary: RunSummary | undefined) {
  const writes: RunSummary[] = [];
  const store = {
    getRun: vi.fn().mockResolvedValue({ ok: true, value: summary }),
    recordRunSummary: vi.fn().mockImplementation(async (s: RunSummary) => {
      writes.push(s);
      return { ok: true };
    }),
  } as unknown as RunHistoryStore;
  return { store, writes };
}

/** Minimal summary: the wrapper spreads it, so a complete RunSummary shape is not what is under test. */
const SUMMARY = { runId: "r1", repo: "owner/repo", issue: 704 } as unknown as RunSummary;

const gitReturning = (stdout: string, exitCode = 0) =>
  vi.fn().mockResolvedValue({ stdout, exitCode });

describe("#704 - capturing the run diff reports its outcome", () => {
  it("records the diff and says so", async () => {
    const { store, writes } = fakeStore(SUMMARY);
    const runGit = gitReturning("diff --git a/src/App.jsx b/src/App.jsx\n+1 line\n");

    const outcome = await recordRunDiffWithOutcome(store, "r1", "/ws", { runGit });

    expect(outcome).toBe("recorded");
    expect(writes).toHaveLength(1);
    expect(writes[0].gitDiff).toContain("src/App.jsx");
  });

  it("redacts inline DF_* secrets on the way through", async () => {
    const { store, writes } = fakeStore(SUMMARY);
    const runGit = gitReturning("+DF_API_KEY=super-secret-value\n");

    const outcome = await recordRunDiffWithOutcome(store, "r1", "/ws", { runGit });

    expect(outcome).toBe("recorded");
    // The value must never reach storage, only the variable name.
    expect(writes[0].gitDiff).not.toContain("super-secret-value");
    expect(writes[0].gitDiff).toContain("redacted");
  });

  it("CONTROL: no changes persists NOTHING - not an empty string", async () => {
    const { store, writes } = fakeStore(SUMMARY);
    const runGit = gitReturning("");

    const outcome = await recordRunDiffWithOutcome(store, "r1", "/ws", { runGit });

    // "no changes" and "an empty diff was stored" must not look the same to whoever reads the run later.
    expect(outcome).toBe("no-changes");
    expect(writes).toHaveLength(0);
  });

  it("CONTROL: no git seam attempts nothing and says so", async () => {
    const { store, writes } = fakeStore(SUMMARY);

    const outcome = await recordRunDiffWithOutcome(store, "r1", "/ws", {});

    // The non-sandbox path has no seam to run git through; it must not be mistaken for "nothing changed".
    expect(outcome).toBe("unavailable");
    expect(writes).toHaveLength(0);
  });

  it("reports a capture failure instead of throwing, so a green run stays green", async () => {
    const { store } = fakeStore(SUMMARY);
    const runGit = vi.fn().mockRejectedValue(new Error("sandbox went away"));

    const outcome = await recordRunDiffWithOutcome(store, "r1", "/ws", { runGit });

    // The whole point: a diagnostic that cannot be written must not end a run that succeeded.
    expect(outcome).toBe("failed");
  });

  it("reports a missing summary rather than quietly doing nothing", async () => {
    const { store, writes } = fakeStore(undefined);
    const runGit = gitReturning("+a change\n");

    const outcome = await recordRunDiffWithOutcome(store, "r1", "/ws", { runGit });

    expect(outcome).toBe("no-summary");
    expect(writes).toHaveLength(0);
  });
});
