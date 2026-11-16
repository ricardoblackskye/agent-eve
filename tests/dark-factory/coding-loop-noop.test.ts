/**
 * #651 — the coding loop must DETECT a no-op self-correction.
 *
 * A real local run (WebFeedPOC#203) wrote byte-identical files on consecutive iterations, failed the
 * target's tests every time, and then tripped the breaker with `failed-selfcorrect-exceeded`. The suite
 * itself was healthy (the original test passed 3/3), so the loop re-authored the SAME artefact and
 * repeated the SAME failure — a no-op that silently consumed the whole breaker budget.
 *
 * The loop cannot see the authored bytes, so the WORKER reports an opaque artefact identity for the
 * iteration (`artefactHash`). When a FAILING iteration reports the SAME identity as the previous failing
 * iteration, the loop has proof it cannot self-correct: it must STOP and say so, rather than repeating.
 *
 * Backwards compatible: a worker that reports no identity behaves exactly as before.
 */
import { describe, it, expect } from "vitest";
import { runMultiFileCodingLoop } from "../../agent/lib/dark-factory/developer-agent";

const PLAN = {
  storyId: 203,
  targetFiles: [{ path: "src/components/ProductList.jsx", action: "modify" }],
} as never;
const TOOLS = {} as never;

describe("#651 the coding loop detects a no-op self-correction", () => {
  it("stops as soon as a failing iteration repeats the previous iteration's artefact", async () => {
    const seen: number[] = [];

    const result = await runMultiFileCodingLoop({
      plan: PLAN,
      tools: TOOLS,
      maxIterations: 10,
      worker: async (ctx) => {
        seen.push(ctx.iteration);
        // Byte-identical every time: the same artefact identity and the same failure.
        return { passed: false, output: "Tests failed: 1 failed", artefactHash: "identical" };
      },
    });

    // It must NOT burn all 10 iterations before the breaker stops it.
    expect(result.iterations).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("no-op-self-correction");
    expect(seen).toEqual([1, 2]);
  });

  it("keeps iterating while the artefact changes (a real fix cycle)", async () => {
    const seen: number[] = [];

    const result = await runMultiFileCodingLoop({
      plan: PLAN,
      tools: TOOLS,
      maxIterations: 3,
      worker: async (ctx) => {
        seen.push(ctx.iteration);
        return {
          passed: false,
          output: `Tests failed: ${ctx.iteration}`,
          artefactHash: `h${ctx.iteration}`,
        };
      },
    });

    expect(result.iterations).toBe(3);
    expect(result.stopReason).toBeUndefined();
    expect(seen).toEqual([1, 2, 3]);
  });

  it("does not treat a passing iteration as a no-op", async () => {
    const result = await runMultiFileCodingLoop({
      plan: PLAN,
      tools: TOOLS,
      maxIterations: 5,
      worker: async () => ({ passed: true, artefactHash: "identical" }),
    });

    expect(result.status).toBe("success");
    expect(result.iterations).toBe(1);
    expect(result.stopReason).toBeUndefined();
  });

  it("ignores an absent artefact identity (a worker that reports only a verdict)", async () => {
    // Backwards compatible: with no identity there is no no-op detection and the loop behaves as before.
    const result = await runMultiFileCodingLoop({
      plan: PLAN,
      tools: TOOLS,
      maxIterations: 2,
      worker: async () => ({ passed: false, output: "verdict only" }),
    });

    expect(result.iterations).toBe(2);
    expect(result.stopReason).toBeUndefined();
  });
});
