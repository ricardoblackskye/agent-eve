/**
 * Docs drift guards (#238) — make documentation drift fail CI.
 *
 * Five guards, each a pure function `(scanned data) => violations[]` plus:
 *  - an integration test over the real repo (green today), and
 *  - a mutation test that injects synthetic drift and asserts the guard fires
 *    (proves the guard is not vacuous — a vacuous guard is worse than none).
 *
 * All five run in the standard `vitest` Unit Tests CI job, so drift fails CI
 * rather than auto-opening a PR.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { PRICE_FLOOR_DATA_RELATIVE_PATH } from "../agent/lib/dark-factory/model-price-floor";
import { listApiRoutes, getReferencePage } from "../app/documentation/reference/generators";

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// filesystem scanners (independent of the generators under test)
// ---------------------------------------------------------------------------

function walk(dir: string, pred: (p: string) => boolean): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const full = join(dir, e);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) out.push(...walk(full, pred));
    else if (pred(full)) out.push(full);
  }
  return out;
}

const DF_DIR = join(ROOT, "agent", "lib", "dark-factory");
const isTs = (p: string) => p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.endsWith(".test.ts");

function listDfModules(): string[] {
  return walk(DF_DIR, isTs)
    .map((p) => p.slice(ROOT.length + 1).split("\\").join("/"))
    .sort();
}

function listDocPages(): { file: string; content: string }[] {
  return walk(join(ROOT, "docs", "pages"), (p) => p.endsWith(".md")).map((p) => ({
    file: p.slice(ROOT.length + 1).split("\\").join("/"),
    content: readFileSync(p, "utf8"),
  }));
}

function listAdrFiles(): string[] {
  return walk(join(ROOT, "docs", "adr"), (p) => /^\d{4}-.*\.md$/.test(basename(p))).map(
    (p) => p.slice(ROOT.length + 1).split("\\").join("/"),
  );
}

function documentedEnvVars(): string[] {
  const text = readFileSync(join(ROOT, ".env.example"), "utf8");
  const vars: string[] = [];
  const re = /^\r?([A-Z][A-Z0-9_]*)\s*=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) vars.push(m[1]);
  return vars;
}

function darkFactorySeamNames(): string[] {
  return walk(DF_DIR, isTs)
    .map((p) => basename(p, ".ts"))
    .filter((b) => /(?:provider|store|control|state)$/.test(b))
    .filter((b) => !/(sqlite|postgres|console)$/.test(b))
    .sort();
}

function migrationFiles(): string[] {
  return walk(join(ROOT, "db", "migrations"), (p) => p.endsWith(".sql"))
    .map((p) => basename(p))
    .sort();
}

function testAndEvalFiles(): string[] {
  const tests = walk(join(ROOT, "tests"), (p) => p.endsWith(".test.ts")).map((p) =>
    p.slice(ROOT.length + 1).split("\\").join("/"),
  );
  const evals = walk(join(ROOT, "evals"), (p) => p.endsWith(".eval.ts")).map((p) =>
    p.slice(ROOT.length + 1).split("\\").join("/"),
  );
  return [...tests, ...evals].sort();
}

// ---------------------------------------------------------------------------
// pure guard functions
// ---------------------------------------------------------------------------

function findOrphanAdrs(adrFiles: string[], adrIndexText: string): string[] {
  return adrFiles.filter((f) => !adrIndexText.includes(basename(f)));
}

interface DeadLink {
  file: string;
  link: string;
}

function findDeadLinks(pages: { file: string; content: string }[]): DeadLink[] {
  const out: DeadLink[] = [];
  for (const { file, content } of pages) {
    const dir = dirname(file);
    for (const m of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = m[1];
      if (/^https?:\/\//.test(link)) continue; // external
      if (link.startsWith("#")) continue; // in-page anchor
      if (link.startsWith("/")) continue; // runtime route (e.g. /documentation/*)
      const target = resolve(dir, link);
      if (!existsSync(target)) out.push({ file, link });
    }
  }
  return out;
}

function findUndocumentedModules(modules: string[], docText: string): string[] {
  return modules.filter((m) => !docText.includes(m));
}

function missingEntities(expected: string[], generated: string): string[] {
  return expected.filter((e) => !generated.includes(e));
}

async function generatedMarkdown(slug: string): Promise<string> {
  const page = getReferencePage(slug);
  if (!page) throw new Error(`missing reference page: ${slug}`);
  return await page.generate();
}

// ---------------------------------------------------------------------------
// guard 1 — no orphan ADRs
// ---------------------------------------------------------------------------

describe("guard: no orphan ADRs", () => {
  const adrFiles = listAdrFiles();
  const indexText = readFileSync(join(ROOT, "docs", "adr", "README.md"), "utf8");

  it("integration: every ADR is linked from the index", () => {
    expect(findOrphanAdrs(adrFiles, indexText)).toEqual([]);
  });

  it("mutation: an ADR absent from the index is caught", () => {
    const ghost = "docs/adr/9999-ghost-adr.md";
    expect(findOrphanAdrs([ghost], "index links 0001 but not 9999")).toContain(ghost);
  });
});

// ---------------------------------------------------------------------------
// guard 2 — no dead internal links
// ---------------------------------------------------------------------------

describe("guard: no dead internal links", () => {
  const pages = listDocPages();

  it("integration: every relative link resolves", () => {
    expect(findDeadLinks(pages)).toEqual([]);
  });

  it("mutation: a broken relative link is caught", () => {
    const page = pages[0];
    const broken = { ...page, content: `${page.content}\n[nope](does-not-exist.md)` };
    expect(findDeadLinks([broken])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// guard 3 — derived pages match source
// ---------------------------------------------------------------------------

describe("guard: derived pages match source", () => {
  it("environment page reflects .env.example", async () => {
    const md = await generatedMarkdown("environment");
    expect(missingEntities(documentedEnvVars(), md)).toEqual([]);
  });

  it("api-routes page reflects app/api routes", async () => {
    const md = await generatedMarkdown("api-routes");
    expect(missingEntities(listApiRoutes().map((r) => r.path), md)).toEqual([]);
  });

  it("platform-seams page reflects dark-factory seams", async () => {
    const md = await generatedMarkdown("platform-seams");
    expect(missingEntities(darkFactorySeamNames(), md)).toEqual([]);
  });

  it("migrations page reflects db/migrations", async () => {
    const md = await generatedMarkdown("migrations");
    expect(missingEntities(migrationFiles(), md)).toEqual([]);
  });

  it("tests-evals page reflects tests/ and evals/", async () => {
    const md = await generatedMarkdown("tests-evals");
    expect(missingEntities(testAndEvalFiles(), md)).toEqual([]);
  });

  it("mutation: a missing source entity is caught", async () => {
    const md = await generatedMarkdown("api-routes");
    const victim = listApiRoutes()[0].path;
    const stale = md.replace(victim, "ZZZ-MISSING");
    expect(missingEntities([victim], stale)).toContain(victim);
  });
});

// ---------------------------------------------------------------------------
// guard 4 — every Dark Factory module is documented
// ---------------------------------------------------------------------------

describe("guard: every Dark Factory module is documented", () => {
  const modules = listDfModules();
  const docText = listDocPages()
    .map((p) => p.content)
    .join("\n");

  it("integration: every module is referenced from docs", () => {
    expect(findUndocumentedModules(modules, docText)).toEqual([]);
  });

  it("mutation: an undocumented module is caught", () => {
    const ghost = "agent/lib/dark-factory/ghost-module.ts";
    expect(findUndocumentedModules([...modules, ghost], docText)).toContain(ghost);
  });
});

/**
 * Guard 5 (#549): an operator instruction must name the file the command actually writes.
 *
 * The Price Drift workflow posts a repair step naming the file to refresh. It named a JSON path that ADR 0071
 * had already moved to a generated TS module, and nothing failed - the instruction was wrong for as long as
 * nobody read it. Two checks, because "a file with that name exists" is not the claim being made:
 *  - every path-like mention resolves in the repo, and
 *  - the path the instruction names IS the constant the writer itself uses
 *    (`PRICE_FLOOR_DATA_RELATIVE_PATH` exists so the writer and the reader cannot disagree).
 */
const PRICE_DRIFT_WORKFLOW = ".github/workflows/price-drift.yml";
const PATH_LIKE =
  /(?<![\w./-])(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|json|md|yml|yaml|sql|sqlite)\b/g;

/** Every distinct repo-relative path-like mention, boundary-aware: `e2e-usage.sqlite` is not `e2e-usage.sql`. */
function pathsNamedIn(text: string): string[] {
  return [...new Set([...text.matchAll(PATH_LIKE)].map((m) => m[0]))];
}

function unresolvedPaths(paths: string[], resolvePath: (candidate: string) => boolean): string[] {
  return paths.filter((candidate) => !resolvePath(candidate));
}

describe("guard: an operator instruction names real files (#549)", () => {
  const workflow = readFileSync(PRICE_DRIFT_WORKFLOW, "utf8");
  const fromRoot = (candidate: string): boolean => existsSync(resolve(process.cwd(), candidate));

  it("finds path-like mentions at all (otherwise the guard is vacuous)", () => {
    const named = pathsNamedIn(workflow);
    expect(named.length).toBeGreaterThan(0);
    expect(named).toContain("agent/lib/dark-factory/cost-budget.ts");
  });

  it("integration: every path the repair step names exists in the tree", () => {
    const named = pathsNamedIn(workflow);
    expect(named.length).toBeGreaterThan(0);
    expect(unresolvedPaths(named, fromRoot)).toEqual([]);
  });

  it("integration: names the module the refresh command actually writes, not merely one that exists", () => {
    expect(workflow).toContain(PRICE_FLOOR_DATA_RELATIVE_PATH);
    expect(fromRoot(PRICE_FLOOR_DATA_RELATIVE_PATH)).toBe(true);
  });

  it("integration: names a refresh command whose script really handles the write flag", () => {
    expect(workflow).toContain("prices:check");
    expect(workflow).toContain("--write");
    const scripts = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")).scripts;
    const command: string = scripts["prices:check"];
    expect(command).toBeTruthy();
    const scriptFile = command.replace(/^tsx\s+/, "").trim();
    expect(fromRoot(scriptFile)).toBe(true);
    expect(readFileSync(resolve(process.cwd(), scriptFile), "utf8")).toContain("--write");
  });

  it("mutation: an invented path is reported, so the resolver is not answering yes to everything", () => {
    expect(unresolvedPaths(["agent/lib/dark-factory/ghost-module.ts"], fromRoot)).toEqual([
      "agent/lib/dark-factory/ghost-module.ts",
    ]);
  });

  it("mutation: a real-but-wrong path fails the constant check", () => {
    const drifted = workflow.replace(PRICE_FLOOR_DATA_RELATIVE_PATH, "agent/lib/dark-factory/model-price-floor-data.json");
    expect(pathsNamedIn(drifted)).toContain("agent/lib/dark-factory/model-price-floor-data.json");
    expect(drifted).not.toContain(PRICE_FLOOR_DATA_RELATIVE_PATH);
  });
});
