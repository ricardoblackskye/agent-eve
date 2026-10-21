/**
 * #426 - the catalogue declares WHAT; a layout declares WHERE.
 *
 * A scan runs against repositories other than this one. Nine catalogue rows name locations that exist only in this
 * repository (`agent/lib/dark-factory/sandbox.ts`, `docs/adr/0006-...md`, ...). Left in the catalogue, every one of
 * them reports ABSENT against any other repository - a false negative wearing the costume of a measurement.
 *
 * So the layout moves out: the catalogue keeps only conventions that apply to any repository, and a per-repo layout
 * supplies the rest. A row the layout does not address is UNMEASURED, never absent, because we never looked.
 */
import { describe, expect, it } from "vitest";

import { referenceAmmLayout } from "../../agent/lib/dark-factory/amm-layout";
import { AMM_SIGNAL_CATALOGUE } from "../../agent/lib/dark-factory/amm-signals";

/** Rows whose target only exists in a repository laid out like this one. */
const REPO_SPECIFIC = [
  "sandbox-seam",
  "remote-execution",
  "persistent-sessions",
  "provider-seams",
  "structured-logging",
  "run-ledger",
  "diff-capture",
  "vault-injection",
  "rls",
];

interface GuardedRow {
  id: string;
  check: { kind: string; path?: string; command?: string };
}

const rows = AMM_SIGNAL_CATALOGUE as unknown as readonly GuardedRow[];

describe("#426 the catalogue is generic: repo-specific locations come from the layout", () => {
  it("leaves every repo-specific row WITHOUT a hard-coded path", () => {
    const leaked = REPO_SPECIFIC.filter(
      (id) => rows.find((row) => row.id === id)?.check.path !== undefined,
    );

    expect(leaked).toEqual([]);
  });

  it("leaves every other file row a convention any repository could follow", () => {
    const hardCoded = rows
      .filter((row) => row.check.kind === "file" && row.check.path !== undefined)
      .filter((row) => (row.check.path ?? "").startsWith("agent/lib/dark-factory/"))
      .map((row) => `${row.id} -> ${row.check.path}`);

    expect(hardCoded).toEqual([]);
  });

  it("serves every path-less row from the reference layout, so no row is left without a location", () => {
    const missing = rows
      .filter((row) => row.check.kind === "file" && row.check.path === undefined)
      .filter((row) => referenceAmmLayout[row.id] === undefined)
      .map((row) => row.id);

    expect(missing).toEqual([]);
  });

  it("corrects the three paths that were wrong for THIS repository too", () => {
    // These were bare filenames while the files live under agent/lib/dark-factory/, so even a scan of this
    // repository reported a false ABSENT. `sandbox-seam` next door always used the full path.
    expect(referenceAmmLayout["remote-execution"]).toBe(
      "agent/lib/dark-factory/opensandbox-driver.ts",
    );
    expect(referenceAmmLayout["diff-capture"]).toBe("agent/lib/dark-factory/diff-capture.ts");
    expect(referenceAmmLayout["vault-injection"]).toBe(
      "agent/lib/dark-factory/opensandbox-credential-vault.ts",
    );
  });

  it("still addresses persistent-sessions, even though its target does not exist (#430)", () => {
    // The capability is missing, so ABSENT is the correct reading and the layout must supply the path for the
    // scanner to reach that reading. Dropping the entry would turn a missing capability into unmeasured.
    expect(referenceAmmLayout["persistent-sessions"]).toBe(
      "agent/lib/dark-factory/session-resume.ts",
    );
  });
});