/**
 * #465 - the CLI contract an operator scripts against.
 *
 * The exit codes carry meaning, so they are asserted rather than assumed: 0 = the scan was measured, and persisted
 * when a store was configured; 1 = a CONFIGURED store refused the scan, so the measurement was lost. "Printed but
 * not persisted" stays 0, because measuring and printing is still a legitimate use of the command.
 *
 * Importing the script must not RUN it, which is why it guards on `isDirectRun`.
 */
import { describe, expect, it } from "vitest";

import { exitCodeFor, parseArgs } from "../../scripts/amm-scan";
import type { RecordScanOutcome } from "../../agent/lib/dark-factory/amm-scan-provider";

const outcome = (over: Partial<RecordScanOutcome>): RecordScanOutcome => ({
  recorded: false,
  configured: false,
  ...over,
});

describe("#465 df:amm-scan CLI", () => {
  it("parses the required arguments, and the optional ones", () => {
    expect(parseArgs(["node", "s", "--repo", "owner/repo", "--workspace", "."])).toEqual({
      repo: "owner/repo",
      workspace: ".",
      layoutPath: undefined,
      tenant: undefined,
    });

    expect(
      parseArgs([
        "node",
        "s",
        "--repo",
        "owner/repo",
        "--workspace",
        ".",
        "--layout",
        "layout.json",
        "--tenant",
        "tenant-1",
      ]),
    ).toEqual({
      repo: "owner/repo",
      workspace: ".",
      layoutPath: "layout.json",
      tenant: "tenant-1",
    });
  });

  it("refuses to guess: a missing or malformed repo, and a missing workspace, are errors", () => {
    expect(parseArgs(["node", "s", "--workspace", "."])).toHaveProperty("error");
    expect(parseArgs(["node", "s", "--repo", "not-a-pair", "--workspace", "."])).toHaveProperty("error");
    expect(parseArgs(["node", "s", "--repo", "owner/repo"])).toHaveProperty("error");
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    expect(
      parseArgs(["node", "s", "--repo", "owner/repo", "--workspace", ".", "--force"]),
    ).toEqual({ error: "unknown argument: --force" });
  });

  it("exits 0 for a measurement, 0 when nothing was persisted, and 1 when a configured store refused", () => {
    expect(exitCodeFor(outcome({ recorded: true, configured: true }))).toBe(0);
    expect(exitCodeFor(outcome({ recorded: false, configured: false }))).toBe(0);
    expect(
      exitCodeFor(outcome({ recorded: false, configured: true, reason: "connection refused" })),
    ).toBe(1);
  });
});
