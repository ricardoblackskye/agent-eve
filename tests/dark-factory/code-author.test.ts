import { describe, expect, it, vi } from "vitest";
import {
  buildCodeAuthorPrompt,
  CodeAuthorRefusedError,
  createInProcessCodeAuthor,
  createRefusingCodeAuthor,
  parseCodeAuthorOutput,
} from "../../agent/lib/dark-factory/code-author";

/**
 * #281 T1 — the author seam.
 *
 * The `in-process` path must be behaviour-identical to today's inline runner code: same prompt text,
 * same JSON extraction, same failure behaviour. These tests pin that text byte-for-byte, because a
 * silent prompt change would alter what the model is asked to do — the one thing a "zero behaviour
 * change" release must not do.
 */
describe("#281 code author seam", () => {
  const plan = { steps: [{ file: "app/chat.tsx", action: "create" }] };

  it("builds the prompt byte-for-byte as the runner does today", () => {
    expect(buildCodeAuthorPrompt(plan)).toBe(
      [
        "You are Eve's Developer Agent. Execute the following ExecutionPlan:",
        JSON.stringify(plan, null, 2),
        "",
        "For each target file, provide the code to write.",
        "Return a JSON object where keys are relative file paths and values are string file contents.",
        'Example: { "app/chat.tsx": "export ...", "tests/chat.test.ts": "import ..." }',
      ].join("\n"),
    );
  });

  it("parses the authored files map", () => {
    expect(parseCodeAuthorOutput('{"app/a.ts":"export const a = 1;"}')).toEqual({
      "app/a.ts": "export const a = 1;",
    });
  });

  it("extracts the JSON object from surrounding prose", () => {
    const raw = 'Sure! Here is the code:\n{"app/a.ts":"export const a = 1;"}\nDone.';
    expect(parseCodeAuthorOutput(raw)).toEqual({ "app/a.ts": "export const a = 1;" });
  });

  it("throws on unparseable output, so the caller records a failed iteration", () => {
    // Assert the SHAPE of the failure (JSON.parse's SyntaxError), not merely "it threw": an
    // unimplemented stub throws too, which would make this assertion pass vacuously.
    expect(() => parseCodeAuthorOutput("no json here")).toThrow(SyntaxError);
  });

  it("authors through the provided generate function and keeps the raw output", async () => {
    const generate = vi.fn(async () => '{"app/a.ts":"export const a = 1;"}');
    const author = createInProcessCodeAuthor(generate);
    expect(author.author).toBe("in-process");
    const result = await author.write({ plan });
    expect(generate).toHaveBeenCalledWith(buildCodeAuthorPrompt(plan));
    expect(result.files).toEqual({ "app/a.ts": "export const a = 1;" });
    expect(result.raw).toBe('{"app/a.ts":"export const a = 1;"}');
  });

  it("propagates a failed model call rather than returning a partial result", async () => {
    const author = createInProcessCodeAuthor(async () => {
      throw new Error("model call failed");
    });
    await expect(author.write({ plan })).rejects.toThrow("model call failed");
  });

  it("refuses to author when it cannot, with zero side effects", async () => {
    const author = createRefusingCodeAuthor("no author configured");
    expect(author.author).toBe("refusing");
    await expect(author.write({ plan })).rejects.toThrow(CodeAuthorRefusedError);
    await expect(author.write({ plan })).rejects.toThrow(/no author configured/);
  });
});
