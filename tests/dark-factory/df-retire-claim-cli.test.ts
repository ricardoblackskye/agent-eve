/**
 * #404 R2 Task 4 — the CLI contract an operator scripts against.
 *
 * The exit codes carry meaning, so they are asserted rather than assumed: 0 = the claim is gone AND the ticket was
 * reconciled; 2 = the ledger let go but the ticket still lies (a partial outcome must not read as a clean one);
 * 1 = refused (live holder, no claim, or an unavailable ledger).
 *
 * Importing the script must not RUN it, which is why it guards on `isDirectRun`.
 */
import { describe, expect, it } from "vitest";

import { exitCodeFor, parseRetireArgs } from "../../scripts/df-retire-claim";
import type { RetireReport } from "../../agent/lib/dark-factory/retire-claim";

const report = (outcome: RetireReport["outcome"]): RetireReport => ({
  outcome,
  repo: "owner/repo",
  issue: 169,
  clearedLabels: [],
  lines: [],
});

describe("#404 R2 Task 4 - df:retire-claim CLI", () => {
  it("parses the required arguments, and the optional ones", () => {
    expect(parseRetireArgs(["node", "s", "--repo", "owner/repo", "--issue", "169"])).toEqual({
      repo: "owner/repo",
      issue: 169,
      reason: undefined,
      actor: undefined,
    });

    expect(
      parseRetireArgs([
        "node",
        "s",
        "--repo",
        "owner/repo",
        "--issue",
        "169",
        "--reason",
        "the process is gone",
        "--actor",
        "me",
      ]),
    ).toEqual({
      repo: "owner/repo",
      issue: 169,
      reason: "the process is gone",
      actor: "me",
    });
  });

  it("refuses to guess: a missing or malformed repo, and a missing issue, are errors", () => {
    expect(parseRetireArgs(["node", "s", "--issue", "169"])).toHaveProperty("error");
    expect(parseRetireArgs(["node", "s", "--repo", "not-a-pair", "--issue", "169"])).toHaveProperty("error");
    expect(parseRetireArgs(["node", "s", "--repo", "owner/repo"])).toHaveProperty("error");
    expect(parseRetireArgs(["node", "s", "--repo", "owner/repo", "--issue", "abc"])).toHaveProperty("error");
  });

  it("rejects an unknown argument rather than ignoring it", () => {
    expect(
      parseRetireArgs(["node", "s", "--repo", "owner/repo", "--issue", "169", "--force"]),
    ).toEqual({ error: "unknown argument: --force" });
  });

  it("maps outcomes to exit codes: 0 retired, 2 partial, 1 refused", () => {
    expect(exitCodeFor(report("retired"))).toBe(0);
    expect(exitCodeFor(report("retired-unreconciled"))).toBe(2);
    expect(exitCodeFor(report("holder-is-live"))).toBe(1);
    expect(exitCodeFor(report("no-claim"))).toBe(1);
    expect(exitCodeFor(report("store-unavailable"))).toBe(1);
  });
});
