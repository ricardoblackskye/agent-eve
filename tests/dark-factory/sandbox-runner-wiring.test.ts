import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #280 / #281 (R2b/B2) — pin the runner's sandbox wiring.
 *
 * The seam's behaviour is covered by its own unit tests; this guard exists so the wiring cannot be
 * quietly undone later (a reverted import would otherwise only show as a behaviour change at runtime,
 * where nothing exercises it). It also pins that the runner OWNS the lifecycle: the sandbox is created
 * once and disposed via runCodingPhase, because closing the SDK client does not terminate a sandbox.
 */
const source = readFileSync(
  path.resolve(process.cwd(), "scripts/dark-factory-runner.ts"),
  "utf8",
);

describe("#280/#281 runner sandbox wiring (source guard)", () => {
  it("resolves the sandbox provider rather than hard-wiring the local tools", () => {
    expect(source).toMatch(/createSandboxProvider/);
    expect(source).not.toMatch(
      /createWorkspaceTools\s*\(\s*process\.cwd\(\)\s*\)/,
    );
  });

  it("creates the provider exactly once and owns the lifecycle via runCodingPhase", () => {
    const calls = source.match(/createSandboxProvider\(/g) ?? [];
    expect(calls.length).toBe(1);
    // The single provider is handed to the lifecycle owner, which creates AND disposes it.
    expect(source).toMatch(/runCodingPhase\(\s*createSandboxProvider\(/);
    expect(source).toMatch(/provider\.dispose\?\.\(\)/);
  });
});

/**
 * #354 — the VAULT path pushes from INSIDE the sandbox, which forces the git flow into the coding
 * phase: `runCodingPhase` disposes the sandbox in a `finally` the moment the phase returns, so a
 * push placed at STEP 6 would run against a destroyed sandbox. These guards keep the ordering that
 * makes the design work, and keep the host-side push alive for every other driver.
 */
describe("#354 vault-path git wiring (source guard)", () => {
  it("runs the in-sandbox git flow INSIDE the coding phase", () => {
    expect(source).toMatch(/ensureSandboxRepo\(/);
    expect(source).toMatch(/commitAndPushFromSandbox\(/);
    const phaseAt = source.indexOf("runCodingPhase(");
    const pushAt = source.indexOf("commitAndPushFromSandbox(");
    expect(phaseAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(phaseAt);
  });

  it("keeps the host-side push for the non-vault path", () => {
    expect(source).toMatch(/gitPushWithVault\(/);
  });
});

/**
 * #358 — the runner must be able to start.
 *
 * Its entrypoint guard was `require.main === module`, a CommonJS construct. This package is
 * `"type": "module"`, so evaluating it threw `ReferenceError: require is not defined in ES module
 * scope` at module load — BEFORE the guard's own `|| process.argv[1]` fallback could be reached.
 * The documented invocation (`npx tsx scripts/dark-factory-runner.ts`) therefore failed instantly and
 * nothing could start the runner. Nothing in package.json or CI invokes it, which is why a
 * module-system change rotted it unnoticed.
 *
 * The guard compares the module URL with the entry URL instead, which behaves identically under tsx,
 * plain node and vitest.
 */
describe("#358 runner entrypoint guard (source guard)", () => {
  it("does not use the CommonJS-only require.main check", () => {
    expect(source).not.toMatch(/require\.main/);
  });

  it("identifies a direct run through the ESM module URL", () => {
    expect(source).toMatch(/import\.meta\.url/);
    expect(source).toMatch(/pathToFileURL/);
  });
});
