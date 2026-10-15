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
  /**
   * The CURRENT content of each file the plan will MODIFY, keyed by relative path (#361).
   *
   * Without this the author must regenerate a file blind from the plan summary — which is how a
   * 75-line component became a 15-line stub. Omit it when there is nothing to preserve and the prompt
   * stays byte-for-byte what #281 pinned.
   */
  existing?: Record<string, string>;
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

/**
 * The rule that stops an edit from silently becoming a deletion (#361). Its own export so the test can
 * pin the wording, and so the guard's failure message and the prompt cannot drift apart.
 */
export const PRESERVATION_CONTRACT = [
  "Preserve every existing export, import, prop, handler and markup element that the plan does not",
  "ask you to change. Do not delete code you were not asked to change. Never replace a file with a",
  "stub: a shorter file that drops existing behaviour is a failure, not a simplification. Return the",
  "COMPLETE updated file for each. If a whole-file replacement really is the task, the plan must",
  'declare action "replace" for that file.',
].join("\n");

export function buildCodeAuthorPrompt(
  plan: unknown,
  existing?: Record<string, string>,
): string {
  // Byte-for-byte the text the runner sent inline before this seam existed.
  const lines = [
    `You are Eve's Developer Agent. Execute the following ExecutionPlan:`,
    JSON.stringify(plan, null, 2),
    ``,
    `For each target file, provide the code to write.`,
    `Return a JSON object where keys are relative file paths and values are string file contents.`,
    `Example: { "app/chat.tsx": "export ...", "tests/chat.test.ts": "import ..." }`,
  ];

  if (existing && Object.keys(existing).length > 0) {
    lines.push(
      ``,
      `### YOU ARE MODIFYING THESE FILES: KEEP THE CODE THAT IS ALREADY IN THEM`,
      // Rendered as JSON rather than inside a BEGIN/END wrapper: a target may itself be markdown, and
      // prompt-like text inside it would make a hand-rolled delimiter ambiguous.
      JSON.stringify(existing, null, 2),
      ``,
      PRESERVATION_CONTRACT,
    );
  }

  return lines.join("\n");
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
      const raw = await generate(
        buildCodeAuthorPrompt(task.plan, task.existing),
      );
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
