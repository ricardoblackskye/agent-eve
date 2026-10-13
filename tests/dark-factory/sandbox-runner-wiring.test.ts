import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #280 T4 — pin the runner's call site.
 *
 * The seam's behaviour is covered by its own unit tests; this guard exists so the wiring cannot be
 * quietly undone later (a reverted import would otherwise only show as a behaviour change at runtime,
 * where nothing exercises it).
 */
const source = readFileSync(
  path.resolve(process.cwd(), "scripts/dark-factory-runner.ts"),
  "utf8",
);

describe("#280 runner sandbox wiring (source guard)", () => {
  it("resolves the sandbox provider rather than hard-wiring the local tools", () => {
    expect(source).toMatch(/createSandboxProvider/);
    expect(source).not.toMatch(/createWorkspaceTools\s*\(\s*process\.cwd\(\)\s*\)/);
  });

  it("invokes the seam exactly once, to build the workspace tools", () => {
    const calls = source.match(/createSandboxProvider\(/g) ?? [];
    expect(calls.length).toBe(1);
    expect(source).toMatch(/createSandboxProvider\(\)\.create\(process\.cwd\(\)\)/);
  });
});
