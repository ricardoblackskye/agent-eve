/**
 * #281 (R2) — the code AUTHOR seam.
 *
 * Today the runner authors code inline: it builds a prompt, calls the governed model, regex-extracts
 * a JSON object and writes the files. R2 makes the author selectable (an `in-process` model call, or a
 * coding-agent CLI run inside the sandbox) while keeping the `in-process` path as the DEFAULT and
 * behaviour-identical.
 *
 * The seam does NOT write files: it returns the authored map and the caller writes it. That keeps it
 * pure, testable, and leaves the workspace guards on the existing path.
 */

export interface CodeAuthorTask {
  /** The ExecutionPlan to implement (serialized into the prompt exactly as today). */
  plan: unknown;
}

export interface CodeAuthorResult {
  /** Relative path -> file contents, as authored. */
  files: Record<string, string>;
  /** The raw model output, kept for traces and diagnostics. */
  raw: string;
}

export type CodeAuthorKind = "in-process" | "agent-cli" | "refusing";

export interface CodeAuthorProvider {
  readonly author: CodeAuthorKind;
  /** Author one iteration. Refuses (throws) rather than returning an empty result. */
  write(task: CodeAuthorTask): Promise<CodeAuthorResult>;
}

export class CodeAuthorRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeAuthorRefusedError";
  }
}

export function buildCodeAuthorPrompt(plan: unknown): string {
  // Byte-for-byte the text the runner sent inline before this seam existed.
  return [
    `You are Eve's Developer Agent. Execute the following ExecutionPlan:`,
    JSON.stringify(plan, null, 2),
    ``,
    `For each target file, provide the code to write.`,
    `Return a JSON object where keys are relative file paths and values are string file contents.`,
    `Example: { "app/chat.tsx": "export ...", "tests/chat.test.ts": "import ..." }`,
  ].join("\n");
}

/**
 * Same extraction as the runner performed inline: the first `{` through the last `}`, then
 * `JSON.parse`. A failure PROPAGATES — the caller records a failed iteration rather than silently
 * writing nothing.
 */
export function parseCodeAuthorOutput(output: string): Record<string, string> {
  const jsonMatch = output.match(/\{[\s\S]*\}/);
  return JSON.parse(jsonMatch ? jsonMatch[0] : output) as Record<string, string>;
}

/**
 * Today's authoring path, unchanged: one model call, then the same prompt and parse. The CALLER owns
 * governance (category, model, budget) — it hands us a generate function that already runs through
 * the cost gate, so the seam cannot bypass it and stays trivially testable.
 */
export function createInProcessCodeAuthor(
  generate: (prompt: string) => Promise<string>,
): CodeAuthorProvider {
  return {
    author: "in-process",
    write: async (task) => {
      const raw = await generate(buildCodeAuthorPrompt(task.plan));
      return { files: parseCodeAuthorOutput(raw), raw };
    },
  };
}

/** The fail-closed default: it authors nothing and says why. */
export function createRefusingCodeAuthor(reason: string): CodeAuthorProvider {
  return {
    author: "refusing",
    write: async () => {
      throw new CodeAuthorRefusedError(`code author refused: ${reason}`);
    },
  };
}
