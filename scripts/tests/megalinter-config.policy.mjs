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
    assert.ok(
      ciYml.includes("megalinter"),
      "CI workflow must contain a megalinter job",
    );
  });

  it(".mega-linter.yml disables TYPESCRIPT_STANDARD (compatibility with TS 7.x)", () => {
    const config = fs.readFileSync(
      path.join(root, ".mega-linter.yml"),
      "utf-8",
    );
    assert.ok(
      config.includes("TYPESCRIPT_STANDARD"),
      "TYPESCRIPT_STANDARD must be listed in DISABLE_LINTERS (ts-standard crashes on TS 7.x)",
    );
  });

  it(".cspell.json contains project-specific terms", () => {
    const cspell = JSON.parse(
      fs.readFileSync(path.join(root, ".cspell.json"), "utf-8"),
    );
    assert.ok(
      cspell.words.includes("subagent"),
      "cspell must include 'subagent'",
    );
    assert.ok(
      cspell.words.includes("megalinter"),
      "cspell must include 'megalinter'",
    );
    assert.ok(
      cspell.words.includes("releasenotes"),
      "cspell must include 'releasenotes'",
    );
    assert.ok(cspell.words.includes("evals"), "cspell must include 'evals'");
    assert.ok(cspell.words.includes("vercel"), "cspell must include 'vercel'");
    assert.ok(cspell.words.includes("kics"), "cspell must include 'kics'");
  });

  it(".jscpd.json threshold covers observed duplication", () => {
    const jscpd = JSON.parse(
      fs.readFileSync(path.join(root, ".jscpd.json"), "utf-8"),
    );
    assert.ok(
      jscpd.threshold >= 4,
      "jscpd threshold must be >= 4 to tolerate observed duplication",
    );
  });

  it("CI workflow has top-level permissions", () => {
    const ciYml = fs.readFileSync(
      path.join(root, ".github/workflows/ci.yml"),
      "utf-8",
    );
    assert.ok(
      ciYml.includes("permissions:"),
      "CI workflow must set top-level permissions",
    );
  });

  it("pins the MegaLinter action to an immutable release SHA", () => {
    const ciYml = fs.readFileSync(
      path.join(root, ".github/workflows/ci.yml"),
      "utf-8",
    );
    assert.match(
      ciYml,
      /uses: oxsecurity\/megalinter@[0-9a-f]{40}/,
      "MegaLinter action must be pinned to a full commit SHA",
    );
  });

  it("configures Lychee to resolve root-relative links", () => {
    const config = fs.readFileSync(
      path.join(root, ".mega-linter.yml"),
      "utf-8",
    );
    assert.match(
      config,
      /SPELL_LYCHEE_ARGUMENTS:\s+--root-dir\s+\./,
      "Lychee must receive the repository root for root-relative links",
    );
  });

  it(".lycheeignore contains localhost pattern", () => {
    const lychee = fs.readFileSync(path.join(root, ".lycheeignore"), "utf-8");
    assert.ok(
      lychee.includes("127\\.0\\.0\\.1"),
      ".lycheeignore must exclude localhost",
    );
  });

  it("has a narrow Gitleaks allowlist for the historical plan finding", () => {
    const gitleaks = fs.readFileSync(
      path.join(root, ".gitleaks.toml"),
      "utf-8",
    );
    assert.match(gitleaks, /0f09f0f388bb9bc57d89c1a3e142dadfa7f8021b/);
    assert.ok(gitleaks.includes("plans/feat-add-web-ui.md"));
    assert.match(gitleaks, /generic-api-key/);
  });

  it("scopes Checkov's false-positive exclusion to the config file", () => {
    const checkov = fs.readFileSync(path.join(root, ".checkov.yml"), "utf-8");
    assert.match(checkov, /skip-path:/);
    assert.ok(checkov.includes("release-manager.config.json"));
  });

  it("pins every GitHub Action to an immutable commit", () => {
    const ciYml = fs.readFileSync(
      path.join(root, ".github/workflows/ci.yml"),
      "utf-8",
    );
    const unpinned = ciYml.match(/uses:\s+[^\s]+@v\d+/g) || [];
    assert.deepStrictEqual(
      unpinned,
      [],
      "GitHub Actions must use full commit SHAs",
    );
  });

  it("does not retain a credential-shaped value in the active plan", () => {
    const plan = fs.readFileSync(
      path.join(root, "plans/feat-add-web-ui.md"),
      "utf-8",
    );
    assert.doesNotMatch(plan, /eve_sk_[A-Za-z0-9]{20,}/);
  });
});
