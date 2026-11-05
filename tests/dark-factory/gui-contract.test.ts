/**
 * #582 (AC2) - the CLI contract the Windows program depends on, pinned so a future change cannot
 * silently break the GUI's integration.
 *
 * The program renders a step list from NDJSON on stdout and branches on exit codes / problem
 * codes; it must never screen-scrape prose. These tests assert that contract against the
 * in-process modules (fast, deterministic - no subprocess, no cluster).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPrerequisites } from "../../agent/lib/dark-factory/sandbox-check";
import {
  EXIT_CODES,
} from "../../agent/lib/dark-factory/sandbox-exit-codes";
import { createNdjsonEmitter } from "../../agent/lib/dark-factory/sandbox-events";
import { parseFlags } from "../../agent/lib/dark-factory/sandbox-flags";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A committed-shape lock so checkPrerequisites returns a structured, classified result. */
function makeLock(): string {
  const dir = mkdtempSync(join(tmpdir(), "gui-contract-"));
  dirs.push(dir);
  const cache = join(dir, "cache");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "image-0.tar"), "x");
  writeFileSync(join(cache, "image-1.tar"), "x");
  writeFileSync(
    join(dir, "artifacts.lock.json"),
    JSON.stringify({
      chart: { path: "vendor/opensandbox-charts/opensandbox", version: "1.2.0", source: "https://example.invalid" },
      crds: { path: "vendor/opensandbox-crds" },
      images: [
        { ref: "registry.example/execd:1.1.1", digest: `sha256:${"a".repeat(64)}` },
        { ref: "registry.example/egress:1.1.1", digest: `sha256:${"b".repeat(64)}` },
      ],
      binaries: [
        { name: "docker", versionConstraint: ">=20.10.0", required: true, acquiredBy: "operator", probe: { command: "docker", args: ["version"] }, fix: "Install Docker." },
        { name: "kubectl", versionConstraint: ">=1.28.0", required: true, acquiredBy: "operator", probe: { command: "kubectl", args: ["version"] }, fix: "Install kubectl." },
        { name: "helm", versionConstraint: ">=3.14.0", required: true, acquiredBy: "operator", probe: { command: "helm", args: ["version"] }, fix: "Install helm." },
        { name: "python", versionConstraint: ">=3.10.0", required: true, acquiredBy: "operator", probe: { command: "python", args: ["--version"] }, fix: "Install python." },
        { name: "minikube", versionConstraint: ">=1.30.0", required: false, requiredFor: "minikube", acquiredBy: "operator", probe: { command: "minikube", args: ["version"] }, fix: "Install minikube." },
      ],
    }),
  );
  return dir;
}

describe("the GUI contract (#582 / AC2)", () => {
  it("emits one JSON object per line on the NDJSON channel (stdout)", () => {
    const lines: string[] = [];
    const emit = createNdjsonEmitter({ write: (line) => lines.push(line) });
    emit({ step: "check", phase: "start", message: "checking" });
    emit({ step: "done", phase: "success", message: "ok", exitCode: 0 });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws unless it is valid JSON
      expect(typeof parsed.ts).toBe("string");
      expect(typeof parsed.step).toBe("string");
      expect(typeof parsed.phase).toBe("string");
      expect(line.endsWith("\n")).toBe(true); // NDJSON framing
    }
  });

  it("gives each failure class its own exit code (one code per class)", () => {
    const used = new Map<number, string>();
    for (const [code, value] of Object.entries(EXIT_CODES) as [string, number][]) {
      expect(used.has(value), `exit code ${value} is shared by ${code} and ${used.get(value)}`).toBe(false);
      used.set(value, code);
    }
    // The full set the GUI can branch on.
    expect(Object.keys(EXIT_CODES).sort()).toEqual([
      "artifact-unresolvable",
      "cluster-unreachable",
      "internal",
      "prerequisites-mismatch",
      "prerequisites-missing",
      "proof-failed",
      "teardown-failed",
    ]);
  });

  it("--check returns a structured result the GUI can branch on", async () => {
    const exec = async () => ({ code: 0, stdout: "v99.99.99", stderr: "" });
    const result = await checkPrerequisites({ artifactsDir: makeLock(), cluster: "minikube", exec });
    expect(result).toHaveProperty("ok");
    expect(Array.isArray(result.problems)).toBe(true);
    for (const problem of result.problems) {
      expect(typeof problem.code).toBe("string");
      expect(Object.keys(EXIT_CODES)).toContain(problem.code);
    }
  });

  it("refuses secrets on argv so the program never has to pass them inline", () => {
    const { errors } = parseFlags(["--token", "super-secret-value"]);
    expect(errors.some((e) => e.kind === "secret-on-argv")).toBe(true);
  });
});
