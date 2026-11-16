/**
 * #631 - the Developer persona's markdown is the source of truth; this renders the shipped module.
 *
 * The prose cannot live under `agent/lib` as markdown: Eve's discovery validates that tree and rejects a
 * bare `.md` ("Expected ... to be a supported authored module within \"lib/\""), which nothing local
 * catches - not the tests, not `tsc`, not cspell, not markdownlint, and not `npm run build`. So the
 * markdown lives outside it and this script ships it as a generated TypeScript module, which is compiled
 * into the bundle rather than read at runtime.
 *
 * Usage:
 *   npx tsx scripts/sync-developer-persona.ts           # write the module
 *   npx tsx scripts/sync-developer-persona.ts --check   # verify, non-zero exit on drift
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

export const INSTRUCTIONS_RELATIVE_PATH = "docs/dark-factory/developer/instructions.md";
export const MODULE_RELATIVE_PATH = "agent/lib/dark-factory/developer-identity.ts";

const MARKDOWN_PATH = join(REPO, INSTRUCTIONS_RELATIVE_PATH);
const MODULE_PATH = join(REPO, MODULE_RELATIVE_PATH);

/**
 * The order sections are rendered in. Fixed rather than taken from the document, so moving a section in
 * the markdown does not silently reorder the module's exports.
 */
export const SECTION_NAMES = [
  "preamble",
  "target-files",
  "preserve-heading",
  "preservation-contract",
  "feedback-heading",
  "feedback-footer",
] as const;

/** The exported constant for each section. Named, so a rename is a compile error rather than a silent one. */
const CONSTANT_NAMES: Record<(typeof SECTION_NAMES)[number], string> = {
  preamble: "DEVELOPER_PREAMBLE",
  "target-files": "DEVELOPER_TARGET_FILES",
  "preserve-heading": "DEVELOPER_PRESERVE_HEADING",
  "preservation-contract": "PRESERVATION_CONTRACT",
  "feedback-heading": "DEVELOPER_FEEDBACK_HEADING",
  "feedback-footer": "DEVELOPER_FEEDBACK_FOOTER",
};

const startMarker = (name: string) => `<!-- developer-persona:start ${name} -->`;
const endMarker = (name: string) => `<!-- developer-persona:end ${name} -->`;

/**
 * The body of each marked section, keyed by name.
 *
 * The body is taken verbatim between the markers: leading and trailing blank lines are dropped so the
 * markers can be spaced for readability, and every other character is preserved.
 */
export function parseSections(markdown: string): Record<string, string> {
  const text = markdown.replace(/\r\n/g, "\n");
  const sections: Record<string, string> = {};

  for (const name of SECTION_NAMES) {
    const start = text.indexOf(startMarker(name));
    if (start === -1) throw new Error(`missing start marker for section "${name}"`);
    const end = text.indexOf(endMarker(name), start);
    if (end === -1) throw new Error(`missing end marker for section "${name}"`);

    const body = text
      .slice(start + startMarker(name).length, end)
      .replace(/^\n+/, "")
      .replace(/\n+$/, "");

    if (body === "") throw new Error(`section "${name}" is empty`);
    sections[name] = body;
  }

  return sections;
}

/**
 * The TypeScript module text for the sections.
 *
 * A single-line section is one `const`; a multi-line one is an array joined by newlines, which is the
 * idiom `PRESERVATION_CONTRACT` already used and keeps the generated file readable in review.
 */
export function renderIdentityModule(sections: Record<string, string>): string {
  const blocks = SECTION_NAMES.map((name) => {
    const value = sections[name];
    if (value === undefined) throw new Error(`section "${name}" is missing`);
    const lines = value.split("\n");
    const constant = CONSTANT_NAMES[name];

    if (lines.length === 1) {
      return `export const ${constant}: string = ${JSON.stringify(value)};`;
    }
    return [
      `export const ${constant}: string = [`,
      ...lines.map((line) => `  ${JSON.stringify(line)},`),
      '].join("\\n");',
    ].join("\n");
  });

  return [
    "/**",
    " * The Developer's static persona prose (#631).",
    " *",
    " * GENERATED - do not edit by hand. Edit " + INSTRUCTIONS_RELATIVE_PATH + " and run",
    " * `npx tsx scripts/sync-developer-persona.ts`; a drift test fails when the two disagree.",
    " *",
    " * The prose lives in markdown OUTSIDE agent/lib because Eve's discovery rejects a bare .md there",
    " * (see the ADR). This module is what ships it, so there is no runtime file read to be dropped by",
    " * output tracing.",
    " *",
    " * BYTE-IDENTICAL ON PURPOSE: these strings are the exact text the prompt builders emitted before",
    " * the move. A changed prompt changes model behaviour, so do not reword one without re-recording",
    " * the golden prompt contract.",
    " */",
    "",
    ...blocks.flatMap((block) => [block, ""]),
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

/** Write the module (or, with `--check`, fail when the committed copy has drifted). */
export function sync(checkOnly: boolean): { ok: boolean; message: string } {
  const rendered = renderIdentityModule(parseSections(readFileSync(MARKDOWN_PATH, "utf8")));

  if (checkOnly) {
    const committed = readFileSync(MODULE_PATH, "utf8").replace(/\r\n/g, "\n");
    return committed === rendered
      ? { ok: true, message: `${MODULE_RELATIVE_PATH} is up to date.` }
      : { ok: false, message: `${MODULE_RELATIVE_PATH} has drifted; run the script to regenerate it.` };
  }

  writeFileSync(MODULE_PATH, rendered);
  return { ok: true, message: `wrote ${MODULE_RELATIVE_PATH}` };
}

/* istanbul ignore next - the CLI entrypoint, exercised by hand rather than by a unit test. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = sync(process.argv.includes("--check"));
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
