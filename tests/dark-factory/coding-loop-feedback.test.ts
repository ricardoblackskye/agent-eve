/**
 * #373 — the coding loop must be able to SELF-CORRECT.
 *
 * A resume against WebFeedPOC#162 wrote byte-identical files on three consecutive iterations (9691 / 7513 /
 * 3501 chars) and then tripped the breaker with `failed-selfcorrect-exceeded`. That is not a model problem:
 *
 *   - `runMultiFileCodingLoop` invokes the worker as `{ iteration, plan, tools }` — no failure output;
 *   - the worker RETURNS `{ passed: false, output: "Tests failed: …" }`, and the loop reads `res.passed` only,
 *     so the output is discarded;
 *   - `CodeAuthorTask` has no feedback field at all, so the author cannot be told what went wrong.
 *
 * Identical inputs therefore produce identical output, and the breaker trips by construction. The intent was
 * always there — the docstring on `authorFiles` says the failed iteration's message "becomes the next
 * iteration's context" — it was simply never wired.
 *
 * These cases pin the whole path: the loop carries the failure, the prompt shows it to the model, the author
 * sends it, and the prompt stays byte-identical when there is nothing to report (the #281 pin).
 */
import { describe, it, expect } from "vitest";
import { runMultiFileCodingLoop } from "../../agent/lib/dark-factory/developer-agent";
import {
  buildCodeAuthorPrompt,
  createInProcessCodeAuthor,
} from "../../agent/lib/dark-factory/code-author";

const PLAN = {
  storyId: 163,
  targetFiles: [{ path: "src/components/ProductPage.jsx", action: "modify" }],
} as never;
const TOOLS = {} as never;

/** A context object as the worker receives it, captured for assertions. */
type Seen = {
  iteration: number;
  previousFailure?: { iteration: number; output: string };
};

describe("#373 the coding loop can self-correct", () => {
  it("gives iteration 2 the failure from iteration 1", async () => {
    const seen: Seen[] = [];

    const result = await runMultiFileCodingLoop({
      plan: PLAN,
      tools: TOOLS,
      maxIterations: 3,
      worker: async (ctx) => {
        seen.push(ctx as unknown as Seen);
        // Passes only on the second attempt, and only because it was told what failed.
        return { passed: ctx.iteration === 2, output: `boom-${ctx.iteration}` };
      },
    });

    expect(result.status).toBe("success");
    expect(seen).toHaveLength(2);
    // Nothing to correct on the first attempt: no spurious field.
    expect(seen[0].previousFailure).toBeUndefined();
    expect(seen[1].previousFailure).toEqual({ iteration: 1, output: "boom-1" });
  });

  it("reports no failure when the previous iteration produced no output", async () => {
    const seen: Seen[] = [];

    await runMultiFileCodingLoop({
      plan: PLAN,
      tools: TOOLS,
      maxIterations: 2,
      worker: async (ctx) => {
        seen.push(ctx as unknown as Seen);
        return { passed: ctx.iteration === 2 };
      },
    });

    expect(seen[1].previousFailure).toBeUndefined();
  });

  it("shows the failure to the model in the prompt", () => {
    const prompt = buildCodeAuthorPrompt(
      PLAN,
      undefined,
      "Tests failed: expected 1 heading level 2, found 0",
    );

    expect(prompt).toContain("expected 1 heading level 2, found 0");
  });

  it("keeps the prompt byte-identical when there is nothing to report", () => {
    // The #281 pin: with no existing files and no failure, the prompt is what it always was.
    expect(buildCodeAuthorPrompt(PLAN)).toBe(
      buildCodeAuthorPrompt(PLAN, undefined, undefined),
    );
  });

  it("has the in-process author send the feedback it was given", async () => {
    const prompts: string[] = [];
    const author = createInProcessCodeAuthor(async (prompt) => {
      prompts.push(prompt);
      return "{}";
    });

    await author.write({ plan: PLAN, feedback: "Tests failed: 1 failed" });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Tests failed: 1 failed");
  });
});
