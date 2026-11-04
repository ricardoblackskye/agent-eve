/**
 * #585 T7 (AC7) - the sandbox tests run on Windows in CI, not only on Linux.
 *
 * WHY THIS EXISTS: the sandbox CLI is developed on Windows (the operator's box) but CI ran
 * Ubuntu-only. A path separator, a `taskkill` vs `process.kill(-pid)` branch, or a CRLF fixture
 * could pass on Linux and fail on the machine the tool is actually used from. A Windows job
 * catches that before merge.
 *
 * The plan calls this a DEVIATION to flag: a second OS matrix costs CI minutes for a subset of
 * tests. That is a decision for the operator, not a silent addition - so this guard asserts the
 * job exists and the Ubuntu controls remain, and the commit message states the cost.
 *
 * Static: this reads the workflow file. It does not run GitHub Actions.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = resolve(process.cwd(), ".github/workflows/ci.yml");
const workflow = readFileSync(WORKFLOW, "utf8");

/** Split the jobs block into name -> body. Job names sit at two-space indent. */
function jobs(): Map<string, string> {
  const found = new Map<string, string>();
  const start = workflow.indexOf("\njobs:");
  if (start === -1) return found;
  const block = workflow.slice(start + 1);
  const header = /^ {2}([a-z][a-z0-9-]*):$/gm;
  const matches = [...block.matchAll(header)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const name = match[1];
    if (name === undefined) continue;
    const from = match.index ?? 0;
    const next = matches[index + 1];
    const to = next?.index ?? block.length;
    found.set(name, block.slice(from, to));
  }
  return found;
}

const all = jobs();

describe("a Windows job runs the sandbox tests (#585 T7)", () => {
  it("parses at least the known Ubuntu jobs, so the guard is not vacuous", () => {
    // If the parser broke, every assertion below would pass against an empty map.
    expect(all.has("typecheck")).toBe(true);
    expect(all.has("test")).toBe(true);
  });

  it("has a job pinned to windows-latest", () => {
    const windows = [...all.entries()].filter(([, body]) => body.includes("runs-on: windows-latest"));
    expect(windows.length, "no job runs on windows-latest").toBeGreaterThan(0);
  });

  it("runs the sandbox tests in that Windows job", () => {
    const windows = [...all.entries()].filter(([, body]) => body.includes("runs-on: windows-latest"));
    expect(windows.length).toBeGreaterThan(0);
    const combined = windows.map(([, body]) => body).join("\n");
    // The point of the job: the #585 sandbox suites, which are injected and need no cluster.
    for (const suite of ["sandbox-state", "sandbox-check", "sandbox-flags", "sandbox-provisioning"]) {
      expect(combined, `the Windows job does not run ${suite}`).toContain(suite);
    }
  });

  it("keeps the Ubuntu typecheck and unit-test jobs as controls", () => {
    // The deviation is an ADDITION, not a replacement. Losing the Ubuntu jobs would trade one
    // blind spot for another.
    expect(all.get("typecheck")).toContain("runs-on: ubuntu-latest");
    expect(all.get("test")).toContain("runs-on: ubuntu-latest");
  });

  it("does not require Docker or Postgres in the Windows job", () => {
    // The sandbox suites inject their exec function, so a Windows job needs no services. A
    // service block there would fail on windows-latest and the job would never go green.
    // Match the YAML KEY at four-space indent, not the word in prose or a comment.
    const windows = [...all.entries()].filter(([, body]) => body.includes("runs-on: windows-latest"));
    for (const [name, body] of windows) {
      expect(body, `${name} declares a services: block`).not.toMatch(/^ {4}services:$/m);
      expect(body, `${name} declares a postgres service`).not.toMatch(/^ {6}postgres:$/m);
    }
  });
});
