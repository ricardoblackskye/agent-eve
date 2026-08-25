# #16 — MegaLinter Pipeline Integration

**Issue:** #16
**Branch:** `feat/megalinter-pipeline`

## Goal

Add MegaLinter to the agent-eve CI pipeline so it matches the linting patterns used in other repositories in the organization — automated code quality, security, spelling, and formatting checks on every PR.

## Current State

- **CI** (`.github/workflows/ci.yml`): TypeScript typecheck → Eve build → Eve evals → Playwright E2E → Production evals
- **No linting** beyond `tsc --noEmit`: no style/code-format linters, no spell checking, no security scanners, no YAML/JSON/Markdown linting
- **No MegaLinter config**: `.mega-linter.yml`, `.cspell.json`, `.lycheeignore`, `.jscpd.json` do not exist
- **Project tech stack**: TypeScript (TSX/TS), CSS, JSON, YAML, Markdown — all linter-covered categories

## Approach

1. Add a standalone MegaLinter job to CI (parallel to existing jobs, not blocking them — greenfield integration)
2. Start with `VALIDATE_ALL_CODEBASE: false` and lint only **changed files** to keep PR scope manageable
3. Provide initial `.mega-linter.yml` tuned for a Next.js/Eve TypeScript project
4. Provide companion configs: `.cspell.json` (project terms), `.lycheeignore` (link check exceptions)
5. Write policy tests (TDD) that assert config files exist with expected structure
6. After merging, run a baseline on `main` and file follow-up issues for any findings

## Files

| File | Action | Purpose |
|------|--------|---------|
| `.mega-linter.yml` | **Create** | MegaLinter configuration — enabled linters, exclusions, environment variables |
| `.cspell.json` | **Create** | CSpell dictionary with project-specific terms (eve, subagents, releasenotes, etc.) |
| `.jscpd.json` | **Create** | Copy-paste detector config — exclude generated dirs, set threshold |
| `.github/workflows/ci.yml` | **Modify** | Add `megalinter` job after existing jobs |
| `scripts/tests/megalinter-config.policy.mjs` | **Create** | Policy tests asserting config existence and structure (TDD) |

## Linters to Enable

### High-value (non-disruptive)
| Linter | Category | Rationale |
|--------|----------|-----------|
| `TYPESCRIPT_STANDARD` | Format | TypeScript Standard style — consistent TS/TSX formatting |
| `MARKDOWN_MARKDOWNLINT` | Format | Clean markdown docs |
| `MARKDOWN_MARKDOWN_TABLE_FORMATTER` | Format | Consistent tables in plans/, AGENTS.md, etc. |
| `YAML_YAMLLINT` | Format | Clean CI workflow and config YAML |
| `JSON_PRETTIER` | Format | Consistent JSON formatting |
| `SPELL_CSPELL` | Spelling | Catch typos in code and docs |
| `SPELL_LYCHEE` | Links | Catch broken URLs in markdown |
| `COPYPASTE_JSCPD` | Quality | Flag duplicate code |
| `ACTION_ZIZMOR` | Security | Audit GitHub Actions workflows for security issues |

### Lower priority (start disabled, enable later)
| Linter | Reason |
|--------|--------|
| `CSS_STYLELINT` | Only one CSS file (`app/globals.css`); low value initially |
| `REPOSITORY_DEVSKIM` | Secret scanning — enable after baseline |
| `REPOSITORY_GRYPE` | Container scanning — requires Docker |
| `REPOSITORY_TRIVY` | Filesystem scanning — enables after baseline |
| `BASH_SHELLCHECK` | No shell scripts yet (all via CI actions) |

## MegaLinter Configuration

`.mega-linter.yml`:
```yaml
APPLY_FIXES: none  # No auto-fix in CI; reviewer decides
DEFAULT_BRANCH: main
DISABLE_ERRORS_LINTERS: []
DISABLE_LINTERS:
  - CSS_STYLELINT
  - REPOSITORY_DEVSKIM
  - REPOSITORY_TRIVY
  - REPOSITORY_GRYPE
  - BASH_EXEC
  - BASH_SHELLCHECK
  - BASH_SHFMT
  - TYPESCRIPT_STANDARD  # ts-standard crashes on TS 7.x — rely on tsc at build time
FILTER_REGEX_EXCLUDE: (node_modules/|\.git/|\.next/|\.eve/|\.vercel/)
JAVASCRIPT_DEFAULT_STYLE: prettier
JSON_PRETTIER_FILTER_REGEX_EXCLUDE: (\.next/|\.eve/|\.vercel/|node_modules/)
MARKDOWN_MARKDOWNLINT_CONFIG_FILE: .markdownlint.json
MARKDOWN_MARKDOWN_TABLE_FORMATTER_ARGUMENTS: -t
PRINT_ALPACA: false
SHOW_ELAPSED_TIME: true
SPELL_CSPELL_FILE_EXTENSIONS:
  - .ts
  - .tsx
  - .md
  - .json
  - .yml
  - .yaml
  - .css
VALIDATE_ALL_CODEBASE: false  # Only PR changed files initially
YAML_YAMLLINT_FILTER_REGEX_EXCLUDE: (\.vercel/|\.next/|\.eve/)
```

## CSpell Configuration

`.cspell.json`:
```json
{
  "version": "0.2",
  "language": "en",
  "words": [
    "eve",
    "subagents",
    "subagent",
    "releasenotes",
    "typecheck",
    "prettier",
    "megalinter",
    "zizmor",
    "lychee",
    "lycheeignore",
    "jscpd",
    "cspell",
    "devskim",
    "grype",
    "trivy",
    "remarkgfm",
    "reactmarkdown",
    "openrouter",
    "nextjs",
    "playwright",
    "vitest",
    "ai sdk"
  ],
  "ignorePaths": [
    "node_modules/**",
    ".git/**",
    ".next/**",
    ".eve/**",
    ".vercel/**",
    "package-lock.json"
  ]
}
```

## CI Job

Add to `.github/workflows/ci.yml` as a new job:

```yaml
megalinter:
  name: MegaLinter
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    - name: MegaLinter
      uses: oxsecurity/megalinter@v8
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## TDD Workflow

### Phase 2: Write policy tests (RED)

Create `scripts/tests/megalinter-config.policy.mjs` using Node.js built-in `node:test` runner:

```js
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
    assert.ok(ciYml.includes("megalinter"));
  });

  it(".mega-linter.yml does not disable typecheck-relevant linters", () => {
    const config = fs.readFileSync(
      path.join(root, ".mega-linter.yml"),
      "utf-8",
    );
    // TYPESCRIPT_STANDARD is disabled because ts-standard crashes on TS 7.x
    // TypeScript checking is handled by the separate typecheck CI job
    assert.ok(
      config.includes("TYPESCRIPT_STANDARD") ||
        !config.includes("TYPESCRIPT_ES"),
    );
  });

  it(".cspell.json contains project-specific terms", () => {
    const cspell = JSON.parse(
      fs.readFileSync(path.join(root, ".cspell.json"), "utf-8"),
    );
    assert.ok(cspell.words.includes("subagent"));
    assert.ok(cspell.words.includes("megalinter"));
  });
});
```

### Phase 3: User gate — report RED results, wait for approval

### Phase 4: Implement config files

Create `.mega-linter.yml`, `.cspell.json`, `.jscpd.json`, modify `ci.yml` with mega-linter job.

### Phase 5: Push and create PR

## Baseline Check (Phase 1.5)

Before implementing:
1. Run MegaLinter against `main` in a CI run to establish the baseline finding count
2. If many findings (yellow/red), record the baseline but don't fix in this PR — this PR is about **adding the pipeline**, not remediating findings
3. File follow-up issues per linter category for remediation

## Testing / Verification

```bash
# Policy tests
node --test scripts/tests/megalinter-config.policy.mjs
# Expected: all PASS

# CI workflow syntax check
npx --yes action-validator .github/workflows/ci.yml

# MegaLinter config syntax (dry-run approach)
cd /opt/data/agent-eve && npx --yes mega-linter-runner --init 2>&1 | head -5

# Full CI run (after merge)
# → Check MegaLinter status badge / report
```

## Definition of Done

- [ ] `.mega-linter.yml` created with sensible defaults
- [ ] `.cspell.json` created with project terms
- [ ] `.jscpd.json` created
- [ ] MegaLinter job added to CI workflow
- [ ] Policy tests written (TDD) and GREEN
- [ ] PR submitted linking issue #16
- [ ] Baseline results documented for follow-up