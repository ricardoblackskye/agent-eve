/**
 * Eval-workflow protection-bypass guard (issue #227).
 *
 * The eval workflows run against deployments that sit behind Vercel
 * Authentication, so each one must forward the Protection Bypass secret as the
 * `x-vercel-protection-bypass` query parameter — otherwise the evals hit the
 * auth wall and report "Failed to create the session" instead of exercising the
 * app.
 *
 * This is a CI-configuration contract, so there is no runtime behaviour to
 * drive; the guard asserts the plumbing structurally. Assertions are scoped to
 * the individual job block rather than matched repo-wide, because a bare
 * substring match would be satisfied by `preview-evals.yml` and would never
 * exercise `ci.yml` — the file that actually regressed.
 *
 * `production-evals` is gated on `github.ref == 'refs/heads/main'`, so it is
 * `skipped` on every pull request and only runs after a merge. Without this
 * guard a regression here can only be discovered on `main`, after the damage.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const PREVIEW = readFileSync(
  join(ROOT, ".github", "workflows", "preview-evals.yml"),
  "utf8",
);
const README = readFileSync(join(ROOT, "README.md"), "utf8");

/**
 * Extract one job's block from a workflow file. Jobs sit at a 2-space indent
 * under `jobs:`; their properties sit at 4, so the block runs from the job key
 * to the next 2-space key or the next top-level key.
 */
function extractJob(workflow: string, jobName: string): string {
  const lines = workflow.split(/\r?\n/);
  const startIndex = lines.findIndex((line) =>
    new RegExp(`^ {2}${jobName}:`).test(line),
  );
  if (startIndex === -1) {
    throw new Error(`job not found in workflow: ${jobName}`);
  }
  const block: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && /^\S/.test(line)) break; // next top-level key
    if (/^ {2}[A-Za-z0-9_-]+:/.test(line)) break; // next job
    block.push(line);
  }
  return block.join("\n");
}

const PRODUCTION_JOB = extractJob(CI, "production-evals");
const PREVIEW_JOB = extractJob(PREVIEW, "preview-evals");

describe("eval workflows forward the Vercel protection bypass (#227)", () => {
  it("extracts the intended job blocks (guards against a vacuous pass)", () => {
    // If the extractor breaks, every `toContain` below would fail on an empty
    // string for the wrong reason, and every negative assertion would pass
    // vacuously. Anchor the extraction first.
    expect(PRODUCTION_JOB).toContain("eve eval");
    expect(PRODUCTION_JOB).toContain("agent-eve-gold.vercel.app");
    expect(PREVIEW_JOB).toContain("eve eval");
  });

  it("production-evals receives the bypass secret from Actions", () => {
    expect(PRODUCTION_JOB).toMatch(
      /VERCEL_PROTECTION_BYPASS:\s*\$\{\{\s*secrets\.VERCEL_PROTECTION_BYPASS\s*\}\}/,
    );
  });

  it("production-evals appends the bypass to the target URL", () => {
    expect(PRODUCTION_JOB).toContain(
      "x-vercel-protection-bypass=${VERCEL_PROTECTION_BYPASS}",
    );
  });

  it("production-evals handles a target URL that already has a query string", () => {
    expect(PRODUCTION_JOB).toMatch(/&\s*x-vercel-protection-bypass=/);
  });

  it("production-evals passes the built URL to the eval command", () => {
    // Proves the parameter is wired into the invocation, not merely present in
    // the step: a hardcoded `--url https://...` would ignore it entirely.
    expect(PRODUCTION_JOB).toContain('--url "$TARGET_URL"');
  });

  it("production-evals warns when the bypass secret is empty", () => {
    expect(PRODUCTION_JOB).toContain("::warning::");
  });

  it("preview-evals still forwards the bypass (regression guard)", () => {
    expect(PREVIEW_JOB).toMatch(
      /VERCEL_PROTECTION_BYPASS:\s*\$\{\{\s*secrets\.VERCEL_PROTECTION_BYPASS\s*\}\}/,
    );
    expect(PREVIEW_JOB).toContain(
      "x-vercel-protection-bypass=${VERCEL_PROTECTION_BYPASS}",
    );
    expect(PREVIEW_JOB).toContain('--url "$TARGET_URL"');
  });

  it("preview-evals warns when the bypass secret is empty", () => {
    expect(PREVIEW_JOB).toContain("::warning::");
  });

  it("README documents the bypass secret alongside the other eval secrets", () => {
    // The README lists the secrets the eval workflows require. Omitting the
    // bypass is what made the failure look like a flaky eval rather than a
    // configuration gap, so require it nearby.
    const anchor = README.indexOf("EVE_EVAL_AUTH_TOKEN");
    expect(anchor).toBeGreaterThan(-1);
    const window = README.slice(Math.max(0, anchor - 1500), anchor + 1500);
    expect(window).toContain("VERCEL_PROTECTION_BYPASS");
  });
});