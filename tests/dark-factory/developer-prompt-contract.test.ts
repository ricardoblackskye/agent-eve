/**
 * #631 - the assembled Developer prompt, pinned against fixtures captured BEFORE the prose moved.
 *
 * The fixtures are the reason the relocation can be trusted. They were captured from
 * `origin/main:agent/lib/dark-factory/code-author.ts` - the implementation as it stood before any of
 * this existed - with a fixed plan, a fixed file to modify, and a fixed failure report. The persona now
 * comes from markdown via a generated module, so these three comparisons are the proof that the move
 * changed nothing the model sees.
 *
 * Do not edit a fixture to make a test pass. A changed prompt changes model behaviour and invalidates
 * the eval baselines, so a difference here means the new text has to be proven equal to the old.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCodeAuthorPrompt } from "../../agent/lib/dark-factory/code-author";

const ROOT = process.cwd();
const FIXTURE_DIR = "tests/dark-factory/__fixtures__";

/** Git may hand the fixture back with CRLF; the assembled prompt is always LF. */
const normalise = (text: string): string => text.replace(/\r\n/g, "\n");
const fixture = (name: string): string =>
  normalise(readFileSync(resolve(ROOT, FIXTURE_DIR, name), "utf8"));

/** The fixed inputs the fixtures were captured from. Kept identical to the capture script. */
const PLAN = {
  storyId: 203,
  title: "Add the Dark Factory footer",
  targetFiles: [{ path: "src/components/ProductList.jsx", action: "modify" }],
  acceptanceCriteria: [{ id: "AC1", description: "the footer renders" }],
};

const EXISTING = {
  "src/components/ProductList.jsx": [
    'import { useEffect, useState } from "react";',
    "",
    "export function ProductList({ items }) {",
    "  const [visible, setVisible] = useState(items);",
    "  useEffect(() => setVisible(items), [items]);",
    "  return <ul>{visible.map((item) => <li key={item.id}>{item.name}</li>)}</ul>;",
    "}",
  ].join("\n"),
};

const FEEDBACK = [
  "Tests failed:",
  "  x renders the footer line (src/components/ProductList.test.jsx:12:3)",
  "AssertionError: expected undefined to be 'Built by the Dark Factory'",
].join("\n");

describe("#631 the Developer prompt contract is unchanged by the move", () => {
  it("assembles the plan-only prompt exactly as before", () => {
    expect(buildCodeAuthorPrompt(PLAN)).toBe(fixture("developer-code-author-prompt.txt"));
  });

  it("assembles the modify-target prompt exactly as before", () => {
    expect(buildCodeAuthorPrompt(PLAN, EXISTING)).toBe(
      fixture("developer-code-author-prompt-with-existing.txt"),
    );
  });

  it("assembles the self-correction prompt exactly as before", () => {
    expect(buildCodeAuthorPrompt(PLAN, EXISTING, FEEDBACK)).toBe(
      fixture("developer-code-author-prompt-with-feedback.txt"),
    );
  });

  it("keeps the JSON-object instruction and its example verbatim (AC4)", () => {
    const prompt = buildCodeAuthorPrompt(PLAN);

    expect(prompt).toContain(
      "Return a JSON object where keys are relative file paths and values are string file contents.",
    );
    expect(prompt).toContain(
      'Example: { "app/chat.tsx": "export ...", "tests/chat.test.ts": "import ..." }',
    );
  });

  it("compares the exact bytes, so the fixtures are a real oracle", () => {
    // If either side carried a trailing newline the comparison above would still pass while the real
    // prompt differed at its edge, so assert the edges explicitly.
    const prompt = buildCodeAuthorPrompt(PLAN);

    expect(prompt.endsWith("\n")).toBe(false);
    expect(fixture("developer-code-author-prompt.txt").endsWith("\n")).toBe(false);
  });

  it("still emits the plan-only prompt when there is nothing to preserve or repair", () => {
    // The two conditional sections must stay absent, not merely empty: an added blank line would put
    // the prompt out of step with what the model is being asked today.
    const prompt = buildCodeAuthorPrompt(PLAN);

    expect(prompt).not.toContain("YOU ARE MODIFYING THESE FILES");
    expect(prompt).not.toContain("YOUR PREVIOUS ATTEMPT FAILED");
  });
});
