/**
 * #426 (R2) - the scanner measures a repository rather than inventing a fixture.
 *
 * Every assertion here is about a REAL filesystem: a temporary workspace is built and the scan is pointed at it. The
 * point of the issue is that an AMM figure stops being a fixture, so a test that stubbed the filesystem would test the
 * stub instead of the scanner.
 *
 * The three-state rule is what this file exists to pin down: UNMEASURED is not a soft ABSENT. A command we could not
 * run has not been shown missing, and a workspace nobody could read is ignorance, not evidence.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { referenceAmmLayout } from "../../agent/lib/dark-factory/amm-layout";
import type { AmmScan } from "../../agent/lib/dark-factory/amm-readiness";
import { runAmmScan } from "../../agent/lib/dark-factory/amm-scan-runner";
import { catalogueVersion } from "../../agent/lib/dark-factory/amm-signals";
import { createRefusingSandboxProvider } from "../../agent/lib/dark-factory/sandbox";

/** The scan stamp is an input, so every scan here is deterministic. */
const stamp = () => "2026-10-21T00:00:00.000Z";

const COMMAND_ROWS = ["linter", "type-checker", "fast-validation", "fresh-checkout", "fast-suite"];

function stateOf(scan: AmmScan, id: string): string | undefined {
  return scan.pillars
    .flatMap((pillar) => pillar.signals ?? [])
    .find((signal) => signal.id === id)?.state;
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "amm-scan-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("#426 a scan reports what it found, per signal", () => {
  it("reports PRESENT when the file is there and ABSENT when it genuinely is not", async () => {
    writeFileSync(join(workspace, ".cspell.json"), "{}");

    const scan = await runAmmScan({ repo: "owner/repo", workspace, now: stamp });

    expect(stateOf(scan, "spell-check"), "the config was written, so the check ran and found it").toBe("present");
    expect(stateOf(scan, "formatter"), "no .prettierrc was written, so the check ran and found nothing").toBe(
      "absent",
    );
  });

  it("reads a `contains` expectation out of the file itself", async () => {
    writeFileSync(join(workspace, "package.json"), '{ "scripts": { "build": "next build" } }');
    const withBuild = await runAmmScan({ repo: "owner/repo", workspace, now: stamp });
    expect(stateOf(withBuild, "documented-build")).toBe("present");

    writeFileSync(join(workspace, "package.json"), '{ "scripts": { "start": "next start" } }');
    const withoutBuild = await runAmmScan({ repo: "owner/repo", workspace, now: stamp });
    expect(stateOf(withoutBuild, "documented-build"), "the key is gone, so the same check must now say so").toBe(
      "absent",
    );
  });
});

describe("#426 the catalogue is generic, so locations come from a layout", () => {
  it("reports UNMEASURED - never ABSENT - for a repo-specific row with no layout", async () => {
    // sandbox-seam's target exists only in a repository laid out like the reference one.
    const scan = await runAmmScan({ repo: "other/repo", workspace, now: stamp });

    expect(stateOf(scan, "sandbox-seam")).toBe("unmeasured");
    expect(stateOf(scan, "sandbox-seam")).not.toBe("absent");
  });

  it("measures that same row once a layout says where to look", async () => {
    mkdirSync(join(workspace, "agent/lib/dark-factory"), { recursive: true });
    writeFileSync(join(workspace, "agent/lib/dark-factory/sandbox.ts"), "export {};\n");

    const scan = await runAmmScan({
      repo: "other/repo",
      workspace,
      layout: { "sandbox-seam": "agent/lib/dark-factory/sandbox.ts" },
      now: stamp,
    });

    expect(stateOf(scan, "sandbox-seam")).toBe("present");
  });

  it("refuses a layout path that escapes the workspace rather than reading it", async () => {
    const scan = await runAmmScan({
      repo: "owner/repo",
      workspace,
      layout: { "spell-check": "../../outside.txt" },
      now: stamp,
    });

    expect(stateOf(scan, "spell-check")).toBe("unmeasured");
  });
});

describe("#426 a check that could not run is unmeasured, not absent", () => {
  it("executes no command on the host: the refusing default leaves every command row unmeasured", async () => {
    const scan = await runAmmScan({ repo: "owner/repo", workspace, now: stamp });

    for (const id of COMMAND_ROWS) {
      expect(stateOf(scan, id), `${id}: a command we could not run has not been shown missing`).toBe("unmeasured");
    }
  });

  it("leaves command rows unmeasured even when a provider refuses explicitly", async () => {
    const scan = await runAmmScan({
      repo: "owner/repo",
      workspace,
      provider: createRefusingSandboxProvider("test"),
      now: stamp,
    });

    for (const id of COMMAND_ROWS) {
      expect(stateOf(scan, id)).toBe("unmeasured");
    }
  });

  it("treats a workspace that is not there as ignorance, not as a page of absent readings", async () => {
    const scan = await runAmmScan({ repo: "owner/repo", workspace: join(workspace, "gone"), now: stamp });

    const states = scan.pillars
      .flatMap((pillar) => pillar.signals ?? [])
      .map((signal) => signal.state);
    expect(new Set(states)).toEqual(new Set(["unmeasured"]));
    expect(scan.overall.level, "nothing measured cannot be graded").toBe(0);
    // The scorer's own wording for "no readings yet" (UNMEASURED_LABEL, #382) - assert the INTENT, not a synonym.
    expect(scan.overall.label).toMatch(/not yet measured|unmeasured/i);
    expect(scan.overall.label, "an unmeasured repo must not be handed a grade").not.toMatch(/Level \d/);
  });
});

describe("#426 the scan that comes out is one the product can already render", () => {
  it("stamps the scan with the catalogue version that produced it", async () => {
    const scan = await runAmmScan({ repo: "owner/repo", workspace, now: stamp });

    expect(scan.catalogueVersion).toBe(catalogueVersion());
    expect(scan.repo).toBe("owner/repo");
    expect(scan.scannedAt).toBe(stamp());
    expect(scan.pillars).toHaveLength(8);
    expect(scan.overall.maxPoints).toBe(100);
  });

  it("measures THIS repository for real through the reference layout", async () => {
    // The end-to-end proof: no fixture, no stub - the catalogue read against the repository it was written for.
    const scan = await runAmmScan({
      repo: "ricardoblackskye/agent-eve",
      workspace: process.cwd(),
      now: stamp,
    });

    // These three are the paths the catalogue got WRONG (bare filenames). Present proves the layout is what is read.
    for (const id of ["remote-execution", "diff-capture", "vault-injection", "sandbox-seam"]) {
      expect(stateOf(scan, id), `${id} must resolve through the reference layout`).toBe("present");
    }

    // A capability the product genuinely lacks (#430): measured, looked for, and correctly reported missing.
    expect(stateOf(scan, "persistent-sessions")).toBe("absent");
    expect(Object.keys(referenceAmmLayout).length).toBeGreaterThan(0);
  });
});