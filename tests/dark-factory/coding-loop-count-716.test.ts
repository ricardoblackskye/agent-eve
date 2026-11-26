import { describe, expect, it } from "vitest";
import { runCodingLoop } from "../../agent/lib/dark-factory/developer-agent";

/**
 * #716 — the recorded `iteration_count` must be the number of attempts the loop ACTUALLY made.
 *
 * The fix in #769 stopped the summary row fabricating zeros and made the runner supply real counts:
 *
 *   developer-agent.ts:374   iterations = attempt;                       // the loop's own attempt index
 *   developer-agent.ts:400   const fixCycles = passed ? iterations - 1 : iterations;
 *   dark-factory-runner.ts:1711   iterationCount: loopResult.iterations,
 *
 * What was left unproven is the FIRST link: that `iterations` tracks observed attempts rather than being a constant
 * that happens to look right. The live evidence could not settle it — every post-fix run so far recorded `1`, and a
 * one-iteration run cannot distinguish a working counter from a hardcoded one. #716's acceptance asks for the
 * `Coding Iteration N/10` semantics, so the counter must be shown to follow N.
 *
 * This drives the loop for real attempts, which is the observable equivalent of those log lines, and needs no live
 * run's luck in reaching a second iteration.
 *
 * Sensitivity is the PAIR of cases, not one of them: a counter that returned a constant, or echoed `maxIterations`,
 * would pass a single "3 attempts -> 3" assertion while being wrong. The control below (which shares the same
 * maxIterations and passes first time) is what rules those out.
 */
describe("#716 - the loop's iteration count tracks the attempts it actually made", () => {
  it("counts every attempt, and reports the retries as fix cycles", async () => {
    // Fails twice, then passes on the third attempt - the shape the acceptance names (N = 3, not N = 1).
    const result = await runCodingLoop({
      maxIterations: 5,
      worker: async ({ iteration }) => ({ passed: iteration >= 3 }),
    });

    expect(result.iterations).toBe(3);
    // `passed ? iterations - 1 : iterations`: it passed, so the two retries are the fix cycles.
    expect(result.fixCycles).toBe(2);
  });

  it("CONTROL: the same option, passing first time, reports one attempt and no fix cycles", async () => {
    // Same maxIterations as above, so a counter echoing the option would produce 5 here and fail.
    const result = await runCodingLoop({
      maxIterations: 5,
      worker: async () => ({ passed: true }),
    });

    expect(result.iterations).toBe(1);
    expect(result.fixCycles).toBe(0);
  });

  it("CONTROL: a loop that never passes counts ALL attempts as fix cycles", async () => {
    // The other branch of `passed ? iterations - 1 : iterations` - without this, the -1 could be applied
    // unconditionally and the pair above would not notice.
    const result = await runCodingLoop({
      maxIterations: 2,
      worker: async () => ({ passed: false }),
    });

    expect(result.iterations).toBe(2);
    expect(result.fixCycles).toBe(2);
  });
});
