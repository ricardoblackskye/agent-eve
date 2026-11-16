/**
 * #659 - the target's REAL gate is the checks on the pull request.
 *
 * The Definition of Done used to be satisfied by `execSync("npx tsc --noEmit")` in the runner's working
 * directory. On the vault path the run's code lives in the sandbox, so that check inspected a tree
 * WITHOUT the run's changes - it could not fail on the thing it claimed to check. Meanwhile the checks
 * that actually decided whether the PR was mergeable (MegaLinter, and a real `npm ci`/test job) ran
 * somewhere nobody read them, which is how a run reported `done` and opened a red PR.
 *
 * The new gate reads the checks the pull request is running. Its mapping is a pure function so the
 * refusal rules can be pinned without a network: the I/O stays in the runner.
 *
 * The distinction that must survive: "we could not READ the checks" is not "the checks passed". A silent
 * pass there would re-create the exact defect this issue is about, so an unreadable set produces a
 * finding of its own rather than an empty list.
 */
import { describe, expect, it } from "vitest";
import {
  checkRunFindings,
  settlePullRequestChecks,
} from "../../agent/lib/dark-factory/definition-of-done";

const run = (name: string, status: string, conclusion: string | null) => ({
  name,
  status,
  conclusion,
  html_url: `https://github.com/o/r/runs/${name}`,
});

describe("#659 the Definition of Done reads the pull request's checks", () => {
  it("reports nothing when every check passed", () => {
    expect(
      checkRunFindings([
        run("MegaLinter", "completed", "success"),
        run("test", "completed", "success"),
      ]),
    ).toEqual([]);
  });

  it("ignores a check that did not run at all", () => {
    // `skipped` and `neutral` are a decision not to gate on something, not a failure.
    expect(checkRunFindings([run("e2e", "completed", "skipped")])).toEqual([]);
    expect(checkRunFindings([run("CodeQL", "completed", "neutral")])).toEqual([]);
  });

  it("blocks done while a check has FAILED, naming the check", () => {
    const findings = checkRunFindings([run("MegaLinter", "completed", "failure")]);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.source).toBe("linter");
    expect(findings[0]!.message).toMatch(/MegaLinter/);
    // The URL is carried so the human sees WHICH run, without reading the ledger.
    expect(findings[0]!.message).toMatch(/github\.com/);
  });

  it("blocks done for the other ways a check can fail", () => {
    for (const conclusion of ["cancelled", "timed_out", "action_required", "startup_failure"]) {
      const findings = checkRunFindings([run("test", "completed", conclusion)]);
      expect(findings, conclusion).toHaveLength(1);
      expect(findings[0]!.severity).toBe("error");
    }
  });

  it("blocks done while a check is still running, rather than assuming it will pass", () => {
    // A run cannot be certified done against a check that has not finished.
    const findings = checkRunFindings([run("test", "in_progress", null)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toMatch(/not finished|still running|in_progress/i);

    expect(checkRunFindings([run("CodeQL", "queued", null)])).toHaveLength(1);
  });

  it("does NOT read an unreadable check set as a pass", () => {
    // This is the defect's own shape: silence must never be reported as clean.
    const findings = checkRunFindings(null);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toMatch(/could not|cannot|unreadable/i);
    // Non-blocking, so a transient network failure cannot fail an otherwise good run - but visible.
    expect(findings[0]!.severity).toBe("warning");
  });

  it("gives each check a stable id, so recurrence is tracked per check", () => {
    const first = checkRunFindings([run("MegaLinter", "completed", "failure")]);
    const second = checkRunFindings([run("MegaLinter", "completed", "failure")]);
    expect(first[0]!.id).toBe(second[0]!.id);

    const other = checkRunFindings([run("test", "completed", "failure")]);
    expect(other[0]!.id).not.toBe(first[0]!.id);
  });
});

/**
 * #659 - the checks are read for the PR's CURRENT head, and the wait is BOUNDED.
 *
 * `runChecks` is called once per review round, so an unbounded wait would hold the run open on a stalled
 * CI. A check that never settles has to come back as still-running (which the mapping above reports as
 * UNSETTLED, blocking done) rather than being waited on forever or, worse, treated as passed.
 *
 * The clock and the sleep are injected so these cases do not sleep in real time.
 */
describe("#659 settling the pull request's checks", () => {
  const completed = (name: string, conclusion: string) => ({
    name,
    status: "completed",
    conclusion,
    html_url: `https://github.com/o/r/runs/${name}`,
  });

  it("returns the checks as soon as they have all finished, with one read", async () => {
    let reads = 0;
    const result = await settlePullRequestChecks({
      fetchChecks: async () => {
        reads += 1;
        return [completed("test", "success")];
      },
      sleep: async () => {},
      timeoutMs: 1000,
      pollIntervalMs: 10,
      now: () => 0,
    });

    expect(result).toHaveLength(1);
    expect(reads).toBe(1);
  });

  it("polls while a check is still running, then returns the settled result", async () => {
    let reads = 0;
    let clock = 0;
    const result = await settlePullRequestChecks({
      fetchChecks: async () => {
        reads += 1;
        return reads === 1
          ? [{ name: "test", status: "in_progress", conclusion: null }]
          : [completed("test", "success")];
      },
      sleep: async (ms: number) => {
        clock += ms;
      },
      timeoutMs: 1000,
      pollIntervalMs: 10,
      now: () => clock,
    });

    expect(reads).toBeGreaterThan(1);
    expect(result?.[0]?.conclusion).toBe("success");
  });

  it("STOPS waiting at the bound and reports the check as still running", async () => {
    let clock = 0;
    const result = await settlePullRequestChecks({
      fetchChecks: async () => [{ name: "test", status: "in_progress", conclusion: null }],
      sleep: async (ms: number) => {
        clock += ms;
      },
      timeoutMs: 50,
      pollIntervalMs: 10,
      now: () => clock,
    });

    // Handed back NOT settled, so the mapping reports UNSETTLED rather than a pass.
    expect(result?.[0]?.status).toBe("in_progress");
    expect(checkRunFindings(result)[0]?.severity).toBe("error");
    expect(clock).toBeLessThanOrEqual(60);
  });

  it("returns null when the checks cannot be read, and does not keep polling", async () => {
    let reads = 0;
    const result = await settlePullRequestChecks({
      fetchChecks: async () => {
        reads += 1;
        return null;
      },
      sleep: async () => {},
      timeoutMs: 1000,
      pollIntervalMs: 10,
      now: () => 0,
    });

    expect(result).toBeNull();
    expect(reads).toBe(1);
  });
});
