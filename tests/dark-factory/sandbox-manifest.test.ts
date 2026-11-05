/**
 * #603 T1 (D2) - the repo owns the binary manifest.
 *
 * RED: this module does not exist yet. The tests assert the contract the manifest module must
 * satisfy: a tiny version-range matcher (no semver dependency), a messy-output version extractor,
 * and a fail-closed parser that refuses a malformed binaries entry rather than silently passing.
 * They also assert the committed lock file actually carries a valid `binaries` section, so the
 * schema cannot drift from the code.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractVersion,
  parseManifest,
  satisfiesRange,
  type BinaryManifestEntry,
} from "../../agent/lib/dark-factory/sandbox-manifest";

const LOCK = join(process.cwd(), "scripts", "sandbox-vendor", "artifacts.lock.json");

describe("satisfiesRange", () => {
  it("treats bare version as exact", () => {
    expect(satisfiesRange("3.14.0", "3.14.0")).toBe(true);
    expect(satisfiesRange("3.14.1", "3.14.0")).toBe(false);
  });

  it("handles >= constraints", () => {
    expect(satisfiesRange("3.14.1", ">=3.14.0")).toBe(true);
    expect(satisfiesRange("3.13.9", ">=3.14.0")).toBe(false);
  });

  it("handles == constraints", () => {
    expect(satisfiesRange("3.14.0", "==3.14.0")).toBe(true);
    expect(satisfiesRange("3.14.1", "==3.14.0")).toBe(false);
  });

  it("handles ^ caret constraints (major-pinned)", () => {
    expect(satisfiesRange("3.14.9", "^3.14.0")).toBe(true);
    expect(satisfiesRange("3.99.0", "^3.14.0")).toBe(true);
    expect(satisfiesRange("4.0.0", "^3.14.0")).toBe(false);
  });

  it("compares numerically, not lexically", () => {
    expect(satisfiesRange("3.9.0", ">=3.14.0")).toBe(false);
  });
});

describe("extractVersion", () => {
  it("pulls a semver out of noisy CLI output", () => {
    expect(extractVersion("Client Version: v1.29.0")).toBe("1.29.0");
    expect(extractVersion("v3.14.4+gabc123")).toBe("3.14.4");
    expect(extractVersion("Python 3.11.15")).toBe("3.11.15");
  });

  it("returns null when nothing looks like a version", () => {
    expect(extractVersion("error: command not found")).toBeNull();
  });
});

describe("parseManifest", () => {
  it("fails closed on a malformed binaries entry", () => {
    const json = JSON.stringify({
      binaries: [{ name: "helm", acquiredBy: "operator" }], // missing versionConstraint/required/probe/fix
    });
    expect(() => parseManifest(json)).toThrow();
  });

  it("accepts a well-formed binaries entry", () => {
    const entry: BinaryManifestEntry = {
      name: "helm",
      versionConstraint: ">=3.14.0",
      required: true,
      acquiredBy: "operator",
      probe: { command: "helm", args: ["version", "--short"] },
      fix: "Install helm and put it on PATH.",
    };
    const manifest = parseManifest(JSON.stringify({ binaries: [entry] }));
    expect(manifest.binaries).toHaveLength(1);
    expect(manifest.binaries[0].name).toBe("helm");
  });
});

describe("committed lock file", () => {
  it("carries a valid binaries section", () => {
    expect(existsSync(LOCK), "artifacts.lock.json must exist").toBe(true);
    const manifest = parseManifest(readFileSync(LOCK, "utf8"));
    expect(manifest.binaries.length).toBeGreaterThan(0);
    // docker/kubectl/helm must be declared; they are non-optional prerequisites.
    const names = manifest.binaries.map((b) => b.name);
    for (const required of ["docker", "kubectl", "helm"]) {
      expect(names, `lock must declare ${required}`).toContain(required);
    }
  });
});
