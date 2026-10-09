/**
 * Dark Factory — git diff capture (#295).
 *
 * After the developer agent finishes editing its work tree, the diff against
 * the base is captured, any inline `DF_*` secrets are redacted, and the
 * sanitized diff is persisted on the run summary via `recordRunSummary`.
 *
 * The git invocation is injectable so the capture is unit-testable without a
 * real repository.
 */

import { spawn } from "node:child_process";
import type { RunHistoryStore } from "./run-history-store";
import type { RunSummary } from "./run-history";

/** Hard cap on a stored diff; larger diffs are truncated before persisting. */
export const MAX_GIT_DIFF_CHARS = 65536;

/**
 * Redacts inline `DF_*` secret assignments that appear in a captured diff.
 * Env files the developer agent edits can carry `DF_API_KEY=...` lines; we
 * keep the variable name but strip the value so it never lands in storage.
 * Tolerates git's `-`/`+`/` ` line prefixes.
 */
const SECRET_ASSIGNMENT = /(^|\n)[-+ ]?\s*(DF_[A-Z0-9_]+)\s*[=:]\s*\S[^\n]*/g;

export function sanitizeDiff(raw: string): string {
  if (!raw || raw.trim() === "") return "";
  const capped =
    raw.length > MAX_GIT_DIFF_CHARS ? raw.slice(0, MAX_GIT_DIFF_CHARS) : raw;
  return capped.replace(
    SECRET_ASSIGNMENT,
    (_match, newline: string, key: string) => `${newline}# [redacted ${key}]`,
  );
}

/** Injectable git runner; returns combined stdout + the process exit code. */
export type GitRunner = (
  args: string[],
) => Promise<{ stdout: string; exitCode: number }>;

async function defaultRunGit(
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { windowsHide: true });
    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.on("error", () => resolve({ stdout: "", exitCode: 1 }));
    proc.on("close", (code) => resolve({ stdout, exitCode: code ?? 0 }));
  });
}

export interface CaptureWorkspaceDiffOptions {
  runGit?: GitRunner;
  /** Git ref to diff against. Defaults to `HEAD`. */
  baseRef?: string;
}

/**
 * Captures the working-tree diff of `workspaceDir` against `baseRef`,
 * sanitizes it, and returns it. Returns `null` when git fails or the diff is
 * empty (so callers can skip persisting a no-op).
 */
export async function captureWorkspaceDiff(
  workspaceDir: string,
  opts: CaptureWorkspaceDiffOptions = {},
): Promise<string | null> {
  const runGit = opts.runGit ?? defaultRunGit;
  const baseRef = opts.baseRef ?? "HEAD";
  const { stdout, exitCode } = await runGit([
    "-C",
    workspaceDir,
    "diff",
    baseRef,
  ]);
  if (exitCode !== 0) return null;
  const sanitized = sanitizeDiff(stdout);
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Reads the current run summary, captures the workspace diff, and records the
 * summary back with `gitDiff` populated. No-ops when the run is missing, the
 * diff is empty, or git fails.
 */
export async function recordRunDiff(
  store: RunHistoryStore,
  runId: string,
  workspaceDir: string,
  opts: CaptureWorkspaceDiffOptions = {},
): Promise<void> {
  const existing = await store.getRun(runId);
  if (!existing.ok || !existing.value) return;
  const diff = await captureWorkspaceDiff(workspaceDir, opts);
  if (!diff) return;
  const summary: RunSummary = { ...existing.value, gitDiff: diff };
  await store.recordRunSummary(summary);
}
