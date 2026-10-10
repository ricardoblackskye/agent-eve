import { describe, expect, it, vi } from "vitest";
import {
  captureWorkspaceDiff,
  recordRunDiff,
  sanitizeDiff,
} from "../../agent/lib/dark-factory/diff-capture";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import type { RunSummary } from "../../agent/lib/dark-factory/run-history";

const SAMPLE =
  "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";
const SECRET_DIFF =
  "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-DF_API_KEY=sk-secret123\n+DF_API_KEY=sk-new567\n";

function baseSummary(): RunSummary {
  return {
    runId: "r1",
    repo: "o/r",
    issue: 1,
    status: "running",
    stage: "worker",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
    attemptCount: 1,
    reviewCount: 0,
    iterationCount: 1,
    fixCycleCount: 0,
  };
}

describe("sanitizeDiff", () => {
  it("returns empty string for empty/whitespace input", () => {
    expect(sanitizeDiff("")).toBe("");
    expect(sanitizeDiff("   ")).toBe("");
  });

  it("redacts DF_* secret assignments but keeps the key name", () => {
    const out = sanitizeDiff(SECRET_DIFF);
    expect(out).not.toContain("sk-secret123");
    expect(out).not.toContain("sk-new567");
    expect(out).toContain("DF_API_KEY");
  });

  it("caps the diff at MAX_GIT_DIFF_CHARS without throwing", () => {
    const big = "x".repeat(70000);
    expect(sanitizeDiff(big).length).toBeLessThanOrEqual(65536);
  });
});

describe("captureWorkspaceDiff", () => {
  it("returns the sanitized diff via the injected git runner", async () => {
    const runGit = vi.fn(async () => ({ stdout: SECRET_DIFF, exitCode: 0 }));
    const out = await captureWorkspaceDiff("/tmp/ws", { runGit });
    expect(out).not.toContain("sk-secret123");
    expect(runGit).toHaveBeenCalledWith(["-C", "/tmp/ws", "diff", "HEAD"]);
  });

  it("honours a custom baseRef", async () => {
    const runGit = vi.fn(async () => ({ stdout: SAMPLE, exitCode: 0 }));
    await captureWorkspaceDiff("/tmp/ws", { runGit, baseRef: "main" });
    expect(runGit).toHaveBeenCalledWith(["-C", "/tmp/ws", "diff", "main"]);
  });

  it("returns null when git exits non-zero", async () => {
    const runGit = async () => ({ stdout: "", exitCode: 128 });
    expect(await captureWorkspaceDiff("/tmp/ws", { runGit })).toBeNull();
  });

  it("returns null for an empty diff", async () => {
    const runGit = async () => ({ stdout: "\n", exitCode: 0 });
    expect(await captureWorkspaceDiff("/tmp/ws", { runGit })).toBeNull();
  });
});

describe("recordRunDiff", () => {
  it("records the sanitized diff onto the existing summary", async () => {
    const existing = baseSummary();
    const store = {
      getRun: vi.fn(async () => ({ ok: true, value: existing })),
      recordRunSummary: vi.fn(async () => ({
        ok: true,
        mode: "live" as const,
        providerId: "x",
        value: existing,
        duplicate: false,
      })),
    } as unknown as RunHistoryStore;
    const runGit = async () => ({ stdout: SECRET_DIFF, exitCode: 0 });
    await recordRunDiff(store, "r1", "/tmp/ws", { runGit });
    expect(store.recordRunSummary).toHaveBeenCalledTimes(1);
    const recorded = (store.recordRunSummary as unknown as {
      mock: { calls: [RunSummary][] };
    }).mock.calls[0][0];
    expect(recorded.gitDiff).not.toContain("sk-secret123");
    expect(recorded.runId).toBe("r1");
  });

  it("does nothing when the run is not found", async () => {
    const store = {
      getRun: vi.fn(async () => ({ ok: false, error: "missing" })),
      recordRunSummary: vi.fn(async () => ({
        ok: false,
        mode: "blocked" as const,
        providerId: "x",
        error: "missing",
      })),
    } as unknown as RunHistoryStore;
    await recordRunDiff(store, "r1", "/tmp/ws", {
      runGit: async () => ({ stdout: SAMPLE, exitCode: 0 }),
    });
    expect(store.recordRunSummary).not.toHaveBeenCalled();
  });

  it("does nothing when git produces no diff", async () => {
    const store = {
      getRun: vi.fn(async () => ({ ok: true, value: baseSummary() })),
      recordRunSummary: vi.fn(async () => ({
        ok: true,
        mode: "live" as const,
        providerId: "x",
        value: baseSummary(),
        duplicate: false,
      })),
    } as unknown as RunHistoryStore;
    await recordRunDiff(store, "r1", "/tmp/ws", {
      runGit: async () => ({ stdout: "", exitCode: 0 }),
    });
    expect(store.recordRunSummary).not.toHaveBeenCalled();
  });
});
