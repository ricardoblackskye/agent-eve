/**
 * #631 - the Developer persona lives in markdown, and the shipped module is generated from it.
 *
 * The relocation is only honest if three things hold at once:
 *  1. the committed artefact is EXACTLY what the committed markdown renders to (otherwise the markdown
 *     is not really the source of truth - it is a stale copy that nothing reads);
 *  2. the prose is no longer inlined in `code-author.ts` (the relocation is the deliverable); and
 *  3. the exported prose is the exact text the prompt builders emitted before the move, because a
 *     changed prompt changes model behaviour.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSections,
  renderIdentityModule,
} from "../../scripts/sync-developer-persona";
import {
  DEVELOPER_FEEDBACK_FOOTER,
  DEVELOPER_FEEDBACK_HEADING,
  DEVELOPER_PREAMBLE,
  DEVELOPER_PRESERVE_HEADING,
  DEVELOPER_TARGET_FILES,
  PRESERVATION_CONTRACT,
} from "../../agent/lib/dark-factory/developer-identity";

const ROOT = process.cwd();
const MARKDOWN = join(ROOT, "docs", "dark-factory", "developer", "instructions.md");
const MODULE = join(ROOT, "agent", "lib", "dark-factory", "developer-identity.ts");
const CODE_AUTHOR = join(ROOT, "agent", "lib", "dark-factory", "code-author.ts");

/** Line endings differ between the working copy and CI's checkout; the bytes that matter do not. */
const normalise = (text: string): string => text.replace(/\r\n/g, "\n");

describe("#631 the Developer persona is generated from markdown", () => {
  it("ships a module that is exactly what the committed markdown renders to", () => {
    const rendered = renderIdentityModule(parseSections(readFileSync(MARKDOWN, "utf8")));

    expect(normalise(readFileSync(MODULE, "utf8"))).toBe(normalise(rendered));
  });

  it("no longer carries the prose inline in code-author.ts", () => {
    const source = readFileSync(CODE_AUTHOR, "utf8");

    expect(source).not.toContain("You are Eve's Developer Agent");
    expect(source).not.toContain("Preserve every existing export");
  });

  it("exports the preamble and the target-file instruction verbatim", () => {
    expect(DEVELOPER_PREAMBLE).toBe(
      "You are Eve's Developer Agent. Execute the following ExecutionPlan:",
    );
    expect(DEVELOPER_TARGET_FILES).toBe(
      [
        "For each target file, provide the code to write.",
        "Return a JSON object where keys are relative file paths and values are string file contents.",
        'Example: { "app/chat.tsx": "export ...", "tests/chat.test.ts": "import ..." }',
      ].join("\n"),
    );
  });

  it("exports the section headings and the preservation contract verbatim", () => {
    expect(DEVELOPER_PRESERVE_HEADING).toBe(
      "### YOU ARE MODIFYING THESE FILES: KEEP THE CODE THAT IS ALREADY IN THEM",
    );
    expect(PRESERVATION_CONTRACT).toBe(
      [
        "Preserve every existing export, import, prop, handler and markup element that the plan does not",
        "ask you to change. Do not delete code you were not asked to change. Never replace a file with a",
        "stub: a shorter file that drops existing behaviour is a failure, not a simplification. Return the",
        "COMPLETE updated file for each. If a whole-file replacement really is the task, the plan must",
        'declare action "replace" for that file.',
      ].join("\n"),
    );
    expect(DEVELOPER_FEEDBACK_HEADING).toBe(
      "### YOUR PREVIOUS ATTEMPT FAILED - FIX THAT, DO NOT REPEAT IT",
    );
    expect(DEVELOPER_FEEDBACK_FOOTER).toBe(
      "Return the full corrected contents of every target file, as the JSON object described above.",
    );
  });
});
