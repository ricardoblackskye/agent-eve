import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

describe("MegaLinter configuration", () => {
  it("has .mega-linter.yml file", () => {
    assert.ok(fs.existsSync(path.join(root, ".mega-linter.yml")));
  });

  it("has .cspell.json file", () => {
    assert.ok(fs.existsSync(path.join(root, ".cspell.json")));
  });

  it("has .jscpd.json file", () => {
    assert.ok(fs.existsSync(path.join(root, ".jscpd.json")));
  });

  it("has .lycheeignore file", () => {
    assert.ok(fs.existsSync(path.join(root, ".lycheeignore")));
  });

  it("has megalinter job in CI workflow", () => {
    const ciYml = fs.readFileSync(
      path.join(root, ".github/workflows/ci.yml"),
      "utf-8",
    );
    assert.ok(ciYml.includes("megalinter"), "CI workflow must contain a megalinter job");
  });

  it(".mega-linter.yml disables TYPESCRIPT_STANDARD (compatibility with TS 7.x)", () => {
    const config = fs.readFileSync(path.join(root, ".mega-linter.yml"), "utf-8");
    assert.ok(
      config.includes("TYPESCRIPT_STANDARD"),
      "TYPESCRIPT_STANDARD must be listed in DISABLE_LINTERS (ts-standard crashes on TS 7.x)",
    );
  });

  it(".cspell.json contains project-specific terms", () => {
    const cspell = JSON.parse(
      fs.readFileSync(path.join(root, ".cspell.json"), "utf-8"),
    );
    assert.ok(cspell.words.includes("subagent"), "cspell must include 'subagent'");
    assert.ok(cspell.words.includes("megalinter"), "cspell must include 'megalinter'");
    assert.ok(cspell.words.includes("releasenotes"), "cspell must include 'releasenotes'");
    assert.ok(cspell.words.includes("evals"), "cspell must include 'evals'");
    assert.ok(cspell.words.includes("vercel"), "cspell must include 'vercel'");
    assert.ok(cspell.words.includes("kics"), "cspell must include 'kics'");
  });

  it(".jscpd.json threshold is at least 2", () => {
    const jscpd = JSON.parse(
      fs.readFileSync(path.join(root, ".jscpd.json"), "utf-8"),
    );
    assert.ok(jscpd.threshold >= 2, "jscpd threshold must be >= 2 to tolerate boilerplate");
  });

  it("CI workflow has top-level permissions", () => {
    const ciYml = fs.readFileSync(
      path.join(root, ".github/workflows/ci.yml"),
      "utf-8",
    );
    assert.ok(ciYml.includes("permissions:"), "CI workflow must set top-level permissions");
  });

  it(".lycheeignore contains localhost pattern", () => {
    const lychee = fs.readFileSync(
      path.join(root, ".lycheeignore"),
      "utf-8",
    );
    assert.ok(lychee.includes("127.0.0.1"), ".lycheeignore must exclude localhost");
  });
});