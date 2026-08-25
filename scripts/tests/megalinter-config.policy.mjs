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
  });
});