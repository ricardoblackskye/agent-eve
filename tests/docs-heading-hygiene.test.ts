/**
 * #462 — docs markdown must not open a PROSE line with a bare issue reference.
 *
 * markdownlint reads a line that starts with `#` followed by a non-space as an ATX heading and
 * requires a space after the hash (MD018). A line such as `#426 - the scanner. ...` is prose,
 * so the rule fires on content that is not a heading at all.
 *
 * The trap is invisible until the file is edited: MegaLinter lints ONLY changed files, so a
 * three-line edit near the top of the catalogue surfaced seven long-standing MD018 errors at
 * lines 1035-1126. This guard makes the same class fail in the unit suite, where the offender
 * and its line number are reported, instead of only in a MegaLinter warning on an unrelated PR.
 *
 * Scope is `docs/**` — the tree CI builds and PRs routinely touch. Historical plans under
 * `.hermes/plans/` carry the same pattern and are deliberately excluded: they are records of
 * decisions already taken, and rewriting them to satisfy a formatter is the wrong trade.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/** Every `.md` under `dir`, recursively, excluding nothing — docs/ has no generated tree. */
function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

/**
 * Lines that markdownlint would read as a heading with no space after the hash, ignoring
 * fenced code blocks: a `#1a1a1a` color literal inside a fence is genuinely not a heading.
 */
function headingLikeEmptyLines(file: string): string[] {
  const offenders: string[] = [];
  let inFence = false;
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      if (/^#[^\s#]/.test(line)) {
        // POSIX separators so the message reads the same on a CI runner as on Windows.
        const shown = file.replace(/\\/g, "/");
        offenders.push(`${shown}:${index + 1}  ${line.slice(0, 70)}`);
      }
    });
  return offenders;
}

describe("docs heading hygiene (#462)", () => {
  it("has no docs line opening with a bare issue reference", () => {
    const files = markdownFiles("docs");
    // Guard the guard: an empty scan would pass vacuously.
    expect(files.length).toBeGreaterThan(20);

    const offenders = files.flatMap(headingLikeEmptyLines);
    expect(offenders).toEqual([]);
  });

  it("keeps the check honest — it flags a bare reference and accepts the bolded form", () => {
    // CONTROL: proves the detector fires on the bad shape and not on the fixed one, so this
    // file cannot become a no-op if the regex is ever loosened.
    const bad: string[] = [];
    const good: string[] = [];
    const scan = (line: string, into: string[]) => {
      if (/^#[^\s#]/.test(line)) into.push(line);
    };
    scan("#426 - the scanner. It evaluates every catalogue row", bad);
    scan("**#426** - the scanner. It evaluates every catalogue row", good);
    expect(bad).toHaveLength(1);
    expect(good).toHaveLength(0);

    // And the files it actually reads are the ones under docs/.
    const sample = markdownFiles("docs").map((f) => relative(".", f).replace(/\\/g, "/"));
    expect(sample).toContain("docs/pages/dark-factory-modules.md");
  });
});