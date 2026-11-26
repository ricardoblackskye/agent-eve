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
import {
  DEFAULT_PR_CHECKS_TIMEOUT_MS,
  resolvePrChecksTimeoutMs,
} from "../../agent/lib/dark-factory/pr-checks-timeout";

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

/**
 * #676 - the bound on the DoD's wait is a safety cap, not a latency budget.
 *
 * The issue proposed either raising the bound or making it per-repository, and justified the second
 * with "a bound too generous for a fast repository delays every run's verdict". That premise is
 * false, and this file's own cases above prove it: `settlePullRequestChecks` returns as soon as
 * nothing is unsettled ("returns the checks as soon as they have all finished, with one read"), so
 * the timeout is only ever reached by a check that never settles.
 *
 * What the bound is really for, then, is a stuck descriptor - which makes the default a decision to
 * record rather than a number to tune. It also makes a typo in the override dangerous: `Number()`
 * yields NaN, and `now - started >= NaN` is false forever, turning a bounded wait into an unbounded
 * one.
 */
describe("#676 the check-wait bound", () => {
  it("uses the default when the variable is unset or blank", () => {
    expect(resolvePrChecksTimeoutMs({})).toBe(DEFAULT_PR_CHECKS_TIMEOUT_MS);
    expect(resolvePrChecksTimeoutMs({ DF_PR_CHECKS_TIMEOUT_MS: "   " })).toBe(
      DEFAULT_PR_CHECKS_TIMEOUT_MS,
    );
  });

  it("honours an explicit override", () => {
    expect(resolvePrChecksTimeoutMs({ DF_PR_CHECKS_TIMEOUT_MS: "900000" })).toBe(900_000);
  });

  it("FALLS BACK on a typo rather than yielding NaN, which would wait forever", () => {
    // The defect: NaN makes the deadline comparison permanently false, so the wait never breaks.
    for (const typo of ["5m", "abc", "NaN", "null"]) {
      const resolved = resolvePrChecksTimeoutMs({ DF_PR_CHECKS_TIMEOUT_MS: typo });
      expect(Number.isFinite(resolved)).toBe(true);
      expect(resolved).toBe(DEFAULT_PR_CHECKS_TIMEOUT_MS);
    }
  });

  it("falls back for a zero or negative bound, which would refuse every run", () => {
    for (const bad of ["0", "-1", "-600000"]) {
      expect(resolvePrChecksTimeoutMs({ DF_PR_CHECKS_TIMEOUT_MS: bad })).toBe(
        DEFAULT_PR_CHECKS_TIMEOUT_MS,
      );
    }
  });

  it("defaults long enough for the slowest checks the whole-project gate must cover", () => {
    // #659 gates the whole project, so every check is blocking and ONE deadline must cover the pull
    // request's queue plus its slowest descriptor. Observed: e2e and MegaLinter are each around ten
    // minutes on WebFeedPOC, and #224 was STILL unsettled with ten minutes configured. Asserting the
    // floor here records the decision instead of leaving a magic constant - the exact value is pinned
    // in the #722 case below, which superseded this floor's reasoning when the repository outgrew it.
    expect(DEFAULT_PR_CHECKS_TIMEOUT_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("defaults to forty-five minutes, sized for the measured slowest descriptor (#722)", () => {
    // #722: the 20-minute default was sized on the premise that e2e and MegaLinter are each "around
    // ten minutes" on WebFeedPOC. The repository got slower and the number did not move: e2e measured
    // 22 min 8 s on run c2f3ff82 (WebFeedPOC#266, all six checks green) and ~30 minutes across four
    // earlier runs, so a wholly healthy pull request was denied `done` by the CEILING. Pinned as an
    // explicit literal because the fallback cases above compare against the constant itself and would
    // pass at any value.
    expect(DEFAULT_PR_CHECKS_TIMEOUT_MS).toBe(45 * 60_000);
    expect(resolvePrChecksTimeoutMs({})).toBe(45 * 60_000);
  });
});
