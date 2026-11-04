/**
 * #553 AC3 — the proofs run from the installer, not from the operator's second terminal.
 *
 * The defect this pins: `df:sandbox-up` ran bootstrap.sh and then PRINTED two instructions —
 * "port-forward this" and "run vault-proof.py" — leaving the operator to run both by hand.
 * So "the sandbox works" was an unverified claim: nothing failed if the vault proof was never
 * run, and the raw script stayed the entry point with its run-time fetches.
 *
 * What this pins: the documented entry point is the TypeScript core (which refuses when the
 * cache is empty, runs the reachability probe and runs the vault proof), and the verified
 * shell deploy stays reachable as an explicit escape hatch rather than the default.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CLI = resolve(ROOT, "scripts/sandbox-up.ts");
const PKG = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("df:sandbox-up runs the proofs itself (#553 AC3)", () => {
  it("adds a TypeScript entry point that drives the provisioning core", () => {
    expect(existsSync(CLI)).toBe(true);
    const source = readFileSync(CLI, "utf8");
    // The core is the thing that refuses-on-empty-cache and runs the proofs; the CLI must
    // delegate to it rather than re-implement the sequence.
    expect(source).toMatch(/from\s+"[^"]*sandbox-provisioning"/);
    expect(source).toContain("provisionSandbox");
  });

  it("runs the vault proof from the installer", () => {
    const source = readFileSync(CLI, "utf8");
    // AC3: the proof is invoked by this command, not printed as an instruction.
    expect(source).toContain("vault-proof.py");
  });

  it("points df:sandbox-up at the core and keeps the shell as an escape hatch", () => {
    expect(PKG.scripts["df:sandbox-up"]).toContain("sandbox-up.ts");
    expect(PKG.scripts["df:sandbox-up"]).not.toContain("bootstrap.sh");
    // The verified shell deploy is still reachable, explicitly named as such.
    expect(PKG.scripts["df:sandbox-up-shell"]).toContain("bootstrap.sh");
  });

  it("exits non-zero when provisioning fails so a script cannot ignore it", () => {
    const source = readFileSync(CLI, "utf8");
    expect(source).toMatch(/process\.exit\(1\)|exitCode\s*=\s*1/);
  });

  it("offers a read-only --check mode that runs the preflight and mutates nothing", () => {
    const source = readFileSync(CLI, "utf8");
    // #585 T5 (AC5): the flag exists, it delegates to the check module, and the check path
    // returns before the provisioning core is called so nothing can be mutated.
    expect(source).toContain("--check");
    expect(source).toMatch(/from\s+"[^"]*sandbox-check"/);
    expect(source).toContain("checkPrerequisites");
    expect(source).toContain("renderCheck");
    const checkIndex = source.indexOf("checkPrerequisites");
    const provisionIndex = source.indexOf("await provisionSandbox");
    expect(checkIndex).toBeGreaterThan(-1);
    expect(provisionIndex).toBeGreaterThan(-1);
    // The check runs first, so a failing preflight cannot reach the mutating core.
    expect(checkIndex).toBeLessThan(provisionIndex);
  });
});
