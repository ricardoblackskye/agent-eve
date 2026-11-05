/**
 * #585 T8 - the CLI contract and the docs cannot drift apart.
 *
 * Two halves of the same contract were written twice and could disagree silently:
 *  - the exit-code table lives in EXIT_CODES, and the operator-facing table lives in the docs;
 *  - the accepted flags live in the parser, and the help text lives in USAGE.
 *
 * A doc that promises an exit code the code does not return, or advertises a flag the parser
 * rejects as unknown, is worse than no doc: the operator follows it and gets a confusing
 * failure. These tests read the source of truth and the prose together and fail on drift.
 *
 * They are static: no process, no cluster. The real CLI behaviour is proven separately by
 * running the command; this guard is about the documented contract matching the code.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../../agent/lib/dark-factory/sandbox-exit-codes";
import { parseFlags, USAGE } from "../../agent/lib/dark-factory/sandbox-flags";

const DOCS = resolve(process.cwd(), "docs/pages/dark-factory-local-runs.md");
const docs = readFileSync(DOCS, "utf8");

/** Exit-code rows look like: | `prerequisites-missing` | `10` | ... | */
const EXIT_ROW = /\|\s*`([a-z-]+)`\s*\|\s*`(\d+)`\s*\|/g;

function documentedExitCodes(): Map<string, number> {
  const found = new Map<string, number>();
  for (const match of docs.matchAll(EXIT_ROW)) {
    const code = match[1];
    const value = match[2];
    if (code === undefined || value === undefined) continue;
    found.set(code, Number(value));
  }
  return found;
}

describe("the exit-code table matches the docs (#585 T8)", () => {
  it("documents a row for every ProvisionProblemCode", () => {
    const documented = documentedExitCodes();
    for (const [code, value] of Object.entries(EXIT_CODES)) {
      expect(
        documented.has(code),
        `${code} is in EXIT_CODES but has no documented row`,
      ).toBe(true);
      expect(documented.get(code), `${code} documents a different number`).toBe(value);
    }
  });

  it("does not document an exit code the code does not return", () => {
    const documented = documentedExitCodes();
    for (const code of documented.keys()) {
      expect(
        Object.keys(EXIT_CODES).includes(code),
        `${code} is documented but absent from EXIT_CODES`,
      ).toBe(true);
    }
  });

  it("documents the usage-error code 2, which sits outside the problem table", () => {
    // Exit 2 is not a ProvisionProblemCode, so it needs its own documented mention.
    expect(docs).toContain("`2`");
    expect(docs.toLowerCase()).toContain("usage");
  });
});

describe("the help text matches the parser (#585 T8)", () => {
  const advertised = [...new Set(USAGE.match(/--[a-z-]+/g) ?? [])];

  it("advertises at least one flag (otherwise the guard is vacuous)", () => {
    expect(advertised.length).toBeGreaterThan(5);
  });

  it.each(advertised)("accepts the advertised flag %s without calling it unknown", (flag) => {
    // Secret flags are refused on purpose and value flags need a value; neither may be
    // reported as UNKNOWN, because the help text advertises them as real flags.
    const { errors } = parseFlags([flag]);
    const unknown = errors.filter((error) => error.kind === "unknown-flag");
    expect(unknown, `${flag} is advertised in USAGE but the parser calls it unknown`).toEqual([]);
  });
});

describe("the NDJSON contract is documented (#585 T8)", () => {
  it("names every field of the event object", () => {
    for (const field of ["ts", "step", "phase", "message", "exitCode"]) {
      expect(docs).toContain(field);
    }
  });

  it("states that stdout is NDJSON only and prose goes to stderr", () => {
    expect(docs.toLowerCase()).toContain("stdout");
    expect(docs.toLowerCase()).toContain("stderr");
    expect(docs).toContain("NDJSON");
  });

  it("documents the terminal done event", () => {
    expect(docs).toContain("done");
  });
});

describe("the Windows program integration is documented (#582)", () => {
  it("documents the program-to-CLI contract", () => {
    expect(docs.toLowerCase()).toContain("for the windows program");
  });
});

describe("the state file is documented (#585 T8)", () => {
  it("names the state-file path and its invalidation rule", () => {
    expect(docs).toContain(".data/sandbox-provision-state.json");
    expect(docs.toLowerCase()).toContain("invalidate");
  });
});
