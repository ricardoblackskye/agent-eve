/**
 * #553 — the operator docs must not drift from the commands they describe.
 *
 * The defect this pins: `docs/pages/dark-factory-local-runs.md` told operators to run three
 * separate commands (sandbox-up, then sandbox-forward, then sandbox-smoke) and to expect a
 * "READY. Next: port-forward this" hand-off. #553 made `df:sandbox-up` do all three itself and
 * exit non-zero unless the vault proof passed, so that instruction became wrong in a way that
 * silently skipped the proof. A doc that describes a removed workflow is worse than no doc.
 *
 * These assertions are deliberately about the SHAPE of the instructions, not exact prose, so a
 * wording edit does not fail the build while a workflow change does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const DOC = readFileSync(join(ROOT, "docs/pages/dark-factory-local-runs.md"), "utf8");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

/** Every port the doc tells an operator to expect. */
const DOCUMENTED_PORTS = [...DOC.matchAll(/127\.0\.0\.1:(\d+)/g)].map((m) => m[1]);

describe("#553 doc drift — the local-runs guide matches the real commands", () => {
  it("documents the vendor step that the cache requires", () => {
    // An operator who skips vendoring gets "image not found" from the core's refusal path.
    expect(DOC).toContain("df:sandbox-vendor");
  });

  it("documents the one-command provision-and-prove path", () => {
    expect(DOC).toContain("df:sandbox-up");
    // The old doc's separate manual steps must not be presented as the supported workflow.
    const seam = DOC.slice(DOC.indexOf("The sandbox seam"), DOC.indexOf("Secrets at runtime"));
    expect(seam).toContain("df:sandbox-up");
    // `df:sandbox-forward` still exists as an escape hatch, but the doc must not require it.
    expect(seam).not.toMatch(/df:sandbox-forward\s+#\s*port-forward/);
  });

  it("documents teardown, including the cluster-deleting opt-in", () => {
    expect(DOC).toContain("df:sandbox-down");
    expect(DOC).toContain("--delete-cluster");
    // Surgical-by-default is the decision; a doc that implies full reset by default is wrong.
    expect(DOC).toMatch(/surgical/i);
  });

  it("documents the existing-cluster parameter", () => {
    expect(DOC).toContain("KUBE_CONTEXT");
  });

  it("documents each command the doc names as a real npm script", () => {
    // The doc names commands; every one of them must exist in package.json or the operator
    // copy-pastes a command that does not exist.
    const named = [...DOC.matchAll(/npm run (df:sandbox-[a-z-]+)/g)].map((m) => m[1]);
    const unique = [...new Set(named)];
    expect(unique.length).toBeGreaterThan(0);
    for (const script of unique) {
      expect(Object.keys(PKG.scripts), `doc names npm run ${script}`).toContain(script);
    }
  });

  it("the documented default port matches the scripts' default", () => {
    // The port is stated in the doc and defaulted in three scripts. A change to one without the
    // others leaves an operator pointing DF_SANDBOX_ENDPOINT at a port nothing is listening on.
    expect(DOCUMENTED_PORTS.length).toBeGreaterThan(0);
    for (const port of DOCUMENTED_PORTS) {
      expect(port).toBe("18082");
    }
  });

  it("does not promise a separate manual proof step", () => {
    // The hand-off text was the reason the proof could be skipped without anyone noticing.
    expect(DOC).not.toMatch(/READY\. Next:/);
    expect(DOC).not.toMatch(/run vault-proof\.py/i);
  });
});
