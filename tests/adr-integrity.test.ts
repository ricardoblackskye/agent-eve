/**
 * ADR set integrity guard (#237).
 *
 * Architecture Decision Records are the durable record of *why* the system is
 * shaped the way it is. That value collapses the moment the set drifts: an ADR
 * nobody links to is invisible, a mis-numbered file breaks supersession chains,
 * and a record missing its Consequences reads as a rule rather than a trade-off.
 *
 * This is a documentation contract, so there is no runtime behaviour to drive;
 * the guard asserts the set's structure. Assertions are scoped to the ADR
 * directory and deliberately start with a sanity anchor, so that a missing
 * directory or a broken glob fails loudly instead of passing vacuously.
 *
 * The rules encoded here are the ones written into `docs/adr/README.md`.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ADR_DIR = join(ROOT, "docs", "adr");
const INDEX_PATH = join(ADR_DIR, "README.md");

const ADR_FILE = /^\d{4}-[a-z0-9]+(-[a-z0-9]+)*\.md$/;

function adrFiles(): string[] {
  if (!existsSync(ADR_DIR)) return [];
  return readdirSync(ADR_DIR)
    .filter((name) => ADR_FILE.test(name))
    .sort();
}

const FILES = adrFiles();
const INDEX = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, "utf8") : "";

function readAdr(name: string): string {
  return readFileSync(join(ADR_DIR, name), "utf8");
}

describe("ADR set integrity (#237)", () => {
  it("has a non-empty, correctly named ADR set (guards against a vacuous pass)", () => {
    // If the directory or the glob breaks, every assertion below would either
    // throw or pass on an empty set. Anchor the set first.
    expect(existsSync(INDEX_PATH)).toBe(true);
    expect(FILES.length).toBeGreaterThanOrEqual(1);
    for (const name of FILES) {
      expect(name).toMatch(ADR_FILE);
    }
  });

  it("numbers ADRs uniquely and without gaps, starting at 0001", () => {
    const numbers = FILES.map((name) => Number(name.slice(0, 4)));
    expect(numbers.length).toBeGreaterThanOrEqual(1);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual(
      Array.from({ length: numbers.length }, (_, i) => i + 1),
    );
  });

  it("links every ADR from the index (no orphan records)", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(1);
    const orphans = FILES.filter((name) => !INDEX.includes(name));
    expect(orphans).toEqual([]);
  });

  it("gives every ADR a title, a date, a status and the three required sections", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(1);
    for (const name of FILES) {
      const body = readAdr(name);
      expect(body, `${name}: title`).toMatch(/^#\s+\S/m);
      expect(body, `${name}: date`).toMatch(/^\s*[-*]?\s*\*{0,2}Date\*{0,2}:?\*{0,2}\s*\d{4}-\d{2}-\d{2}/m);
      expect(body, `${name}: status`).toMatch(/^\s*[-*]?\s*\*{0,2}Status\*{0,2}:?\*{0,2}\s*(Accepted|Superseded by \d{4})/m);
      expect(body, `${name}: Context`).toMatch(/^##\s+Context\b/m);
      expect(body, `${name}: Decision`).toMatch(/^##\s+Decision\b/m);
      expect(body, `${name}: Consequences`).toMatch(/^##\s+Consequences\b/m);
    }
  });

  it("keeps supersession chains resolvable", () => {
    // An accepted ADR is never edited; a changed decision is a NEW record that
    // supersedes it. That only holds if the referenced number exists.
    expect(FILES.length).toBeGreaterThanOrEqual(1);
    for (const name of FILES) {
      const match = readAdr(name).match(/Superseded by (\d{4})/);
      if (!match) continue;
      const target = FILES.some((other) => other.startsWith(match[1]));
      expect(target, `${name} superseded by missing ${match[1]}`).toBe(true);
    }
  });

  it("documents the convention itself in the index", () => {
    // The index carries the rules, not just links — location, numbering,
    // immutability, and the trigger test for when a record is warranted.
    for (const heading of ["Context", "Decision", "Consequences"]) {
      expect(INDEX).toContain(heading);
    }
    expect(INDEX).toMatch(/Superseded/);
    expect(INDEX).toMatch(/template\.md/);
  });

  /**
   * #489 — the record of where a plan estimate is persisted must stay true to the schema that ships.
   *
   * The ADR this guards exists because its predecessor claimed a storage location (`RunSummary`) that was never
   * built, and the divergence stood from #486 until an audit found it. So the check runs in the direction that
   * would have caught it: take the persistence identifiers the ADR NAMES, and require every one of them to exist
   * in the store implementations.
   */
  describe("plan-estimate storage ADR (#489)", () => {
    const STORAGE_ADR = "0073-plan-estimates-live-in-the-plan-ledger.md";
    const STORE_SOURCES = [
      join(ROOT, "agent", "lib", "dark-factory", "run-history-postgres.ts"),
      join(ROOT, "agent", "lib", "dark-factory", "run-history-store.ts"),
    ];

    it("names storage that the shipped schema actually defines", () => {
      const path = join(ADR_DIR, STORAGE_ADR);
      // Assert existence as an ASSERTION, not by letting a read throw: a missing file must read as a real RED.
      expect(existsSync(path), `${STORAGE_ADR} is missing`).toBe(true);
      const adr = readFileSync(path, "utf8");
      const schema = STORE_SOURCES.map((file) => readFileSync(file, "utf8")).join("\n");

      // Extract the identifiers from the ADR itself. A literal list here would let the ADR drift while the
      // guard kept passing, which is the failure mode this exists to prevent.
      const named = [...new Set([...adr.matchAll(/`(df_[a-z_]+)`/g)].map((m) => m[1]))];
      // Non-vacuity anchor: an ADR that stops naming its identifiers would otherwise satisfy this silently.
      expect(named.length, "the ADR names no storage identifiers").toBeGreaterThan(0);

      const missing = named.filter((id) => !schema.includes(id));
      expect(missing, `the ADR names storage that does not exist: ${missing.join(", ")}`).toEqual([]);

      // CONTROL: the lookup must discriminate, or the assertion above is satisfied by any string at all.
      expect(schema.includes("df_definitely_not_a_real_table")).toBe(false);
    });

    it("names the claims it rests on, and the schema carries them", () => {
      const path = join(ADR_DIR, STORAGE_ADR);
      expect(existsSync(path), `${STORAGE_ADR} is missing`).toBe(true);
      const adr = readFileSync(path, "utf8");
      const schema = STORE_SOURCES.map((file) => readFileSync(file, "utf8")).join("\n");

      // The stamp that makes recalibration safe, and the key the accuracy view joins on.
      const required = ["estimator_version", "run_id"];
      expect(required.length).toBeGreaterThan(0);
      for (const identifier of required) {
        expect(adr, `the ADR must name ${identifier}`).toContain(identifier);
        expect(schema, `the schema must define ${identifier}`).toContain(identifier);
      }
    });
  });

  /**
   * #489 — a supersession is only useful if the chain can be walked BOTH ways. The rule above resolves forward
   * (does the successor exist); this resolves backward, so a record cannot point at a successor that silently
   * says nothing about it.
   */
  it("requires a superseding ADR to reference what it supersedes", () => {
    const superseded = FILES.filter((name) => /Superseded by \d{4}/.test(readAdr(name)));
    // Non-vacuity anchor: with nothing superseded yet, this guard would prove nothing at all.
    expect(superseded.length, "no ADR is superseded, so this rule is untested").toBeGreaterThan(0);

    const mentions = (text: string, number: string): boolean => text.includes(number);
    // CONTROL: the predicate must be able to say NO, or the assertion below is decoration.
    expect(mentions("This record supersedes something else entirely.", "0069")).toBe(false);

    for (const name of superseded) {
      const target = readAdr(name).match(/Superseded by (\d{4})/)![1];
      const successor = FILES.find((other) => other.startsWith(target));
      expect(successor, `${name} names a successor that does not exist`).toBeDefined();
      expect(
        mentions(readAdr(successor!), name.slice(0, 4)),
        `${successor} must reference ${name.slice(0, 4)} as the record it supersedes`,
      ).toBe(true);
    }
  });
});