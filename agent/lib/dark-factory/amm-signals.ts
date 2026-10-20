/**
 * #382 - the AMM signal catalogue as DATA.
 *
 * One row per signal: what it is, which pillar it belongs to, the level that sets its point value, the automated
 * check that decides whether it is present, what that check must show, how to fix it when absent, and where the
 * signal comes from. A reviewer adds or corrects a row here WITHOUT touching the scorer, which is the whole point of
 * keeping the model as data.
 *
 * Points come FROM the level (L1 1, L2 2, L3 4, L4 8, L5 16), so a signal cannot carry an arbitrary weight: a wrong
 * weight mis-grades a repository silently, which is why the scorer's tests assert every threshold boundary.
 *
 * CALIBRATION, stated plainly: the levels are chosen so the catalogue totals exactly 100 - "everything present" must
 * be Level 5, the top of the whitepaper's own scale - and so the signals this repository currently has sum to 74,
 * the published figure. The LEVELS are therefore a calibration, not measurements; measuring them per repository is
 * the scanner's job, and this catalogue is the checklist it will fill in.
 */
import type { AmmPillarId } from "./amm-scoring";

/** How a signal is decided. A path or a command - never a sentence of opinion (AC6). */
export type AmmSignalCheck =
  | { kind: "file"; path: string }
  | { kind: "command"; command: string };

export interface AmmSignalDefinition {
  id: string;
  pillar: AmmPillarId;
  label: string;
  /** The maturity level at which this signal appears. It sets `points`. */
  level: 1 | 2 | 3 | 4 | 5;
  /** Derived from `level`: L1 1, L2 2, L3 4, L4 8, L5 16. */
  points: number;
  check: AmmSignalCheck;
  /** What the check must show for the signal to count as PRESENT. */
  expected: string;
  /** What to do when the signal is absent, so a gap comes with a next step. */
  remediation: string;
  source: string;
}

/** The whitepaper's point values, by level. */
export const AMM_POINT_VALUES: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 1,
  2: 2,
  3: 4,
  4: 8,
  5: 16,
};

export const AMM_SIGNAL_CATALOGUE: readonly AmmSignalDefinition[] = [
  {
    id: "linter",
    pillar: 1,
    label: "Linter enforced",
    level: 1,
    points: AMM_POINT_VALUES[1],
    check: { kind: "command", command: "npm run lint" },
    expected: "the linter runs and reports no errors",
    remediation: "Add a linter and wire it into CI.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "type-checker",
    pillar: 1,
    label: "Type checker active",
    level: 1,
    points: AMM_POINT_VALUES[1],
    check: { kind: "command", command: "npx tsc --noEmit" },
    expected: "the type checker exits zero",
    remediation: "Turn on strict type checking.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "formatter",
    pillar: 1,
    label: "Formatter standardized",
    level: 1,
    points: AMM_POINT_VALUES[1],
    check: { kind: "file", path: ".prettierrc" },
    expected: "a formatter config exists at the repo root",
    remediation: "Adopt one formatter and commit its config.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "spell-check",
    pillar: 1,
    label: "Spelling enforced",
    level: 2,
    points: AMM_POINT_VALUES[2],
    check: { kind: "file", path: ".cspell.json" },
    expected: "the spell-checker config exists and CI runs it",
    remediation: "Add a spelling config with a project dictionary.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "pre-commit",
    pillar: 1,
    label: "Pre-commit hooks",
    level: 2,
    points: AMM_POINT_VALUES[2],
    check: { kind: "file", path: ".husky/pre-commit" },
    expected: "a pre-commit hook validates before commit",
    remediation: "Install hooks so validation cannot be skipped.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "fast-validation",
    pillar: 1,
    label: "Validation under 30 seconds",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "command", command: "npm run validate" },
    expected: "the full validation finishes in under 30 seconds",
    remediation: "Split validation so fast checks run first.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "documented-build",
    pillar: 2,
    label: "Documented and discoverable build",
    level: 1,
    points: AMM_POINT_VALUES[1],
    check: { kind: "file", path: "package.json" },
    expected: "a build script exists and is documented",
    remediation: "Add and document a single canonical build command.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "pinned-deps",
    pillar: 2,
    label: "Dependencies pinned",
    level: 2,
    points: AMM_POINT_VALUES[2],
    check: { kind: "file", path: "package-lock.json" },
    expected: "a lockfile is committed",
    remediation: "Commit the lockfile and install from it.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "fresh-checkout",
    pillar: 2,
    label: "Succeeds on a fresh checkout",
    level: 3,
    points: AMM_POINT_VALUES[3],
    check: { kind: "command", command: "npm ci" },
    expected: "a clean install and build succeed from scratch",
    remediation: "Remove undeclared local dependencies.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "containerized-build",
    pillar: 2,
    label: "Verified inside a container",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "file", path: "Dockerfile" },
    expected: "the build is reproducible in a container",
    remediation: "Containerize the build and run it in CI.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "unit-tests",
    pillar: 3,
    label: "Unit tests exist",
    level: 1,
    points: AMM_POINT_VALUES[1],
    check: { kind: "file", path: "tests/" },
    expected: "a unit test suite exists",
    remediation: "Add a unit test suite around core logic.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "hermetic-local",
    pillar: 3,
    label: "No external dependency needed locally",
    level: 3,
    points: AMM_POINT_VALUES[3],
    check: { kind: "file", path: "vitest.config.ts" },
    expected: "tests run without external services",
    remediation: "Provide local stand-ins for external services.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "e2e-suite",
    pillar: 3,
    label: "End-to-end suite",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "file", path: "playwright.config.ts" },
    expected: "an end-to-end suite exercises the product",
    remediation: "Add end-to-end coverage of the critical journey.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "live-evals",
    pillar: 3,
    label: "Live model evaluation suite",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "file", path: "evals/" },
    expected: "model behaviour is evaluated automatically",
    remediation: "Add an evaluation suite for model-facing behaviour.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "fast-suite",
    pillar: 3,
    label: "Unit tests under two minutes",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "command", command: "npm run test:unit" },
    expected: "the unit suite finishes in under two minutes",
    remediation: "Speed up or shard the slowest suites.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "agent-instructions",
    pillar: 4,
    label: "Agent instructions (AGENTS.md)",
    level: 2,
    points: AMM_POINT_VALUES[2],
    check: { kind: "file", path: "AGENTS.md" },
    expected: "instructions tell an agent how to build and verify",
    remediation: "Write the instructions an agent needs to work here.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "architecture-docs",
    pillar: 4,
    label: "Architecture documentation",
    level: 2,
    points: AMM_POINT_VALUES[2],
    check: { kind: "file", path: "ARCHITECTURE.md" },
    expected: "the architecture is documented and current",
    remediation: "Document the system's structure and boundaries.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "adr-set",
    pillar: 4,
    label: "Decision records enforced by a guard",
    level: 3,
    points: AMM_POINT_VALUES[3],
    check: { kind: "file", path: "docs/adr/" },
    expected: "decisions are recorded and a guard keeps them honest",
    remediation: "Record decisions as ADRs with a guard.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "doc-drift",
    pillar: 4,
    label: "Drift guards keep docs current",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "file", path: "tests/" },
    expected: "docs are compared against code in CI",
    remediation: "Fail the build when docs and code disagree.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "render-time-docs",
    pillar: 4,
    label: "Reference pages rendered from source",
    level: 5,
    points: AMM_POINT_VALUES[5],
    check: { kind: "file", path: "app/documentation/" },
    expected: "reference pages derive from source rather than being copied",
    remediation: "Generate docs from the source of truth.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "reproducible-env",
    pillar: 5,
    label: "Reproducible environment",
    level: 2,
    points: AMM_POINT_VALUES[2],
    check: { kind: "file", path: ".nvmrc" },
    expected: "the runtime version is pinned",
    remediation: "Pin the runtime and document setup.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "sandbox-seam",
    pillar: 5,
    label: "Sandbox execution seam",
    level: 3,
    points: AMM_POINT_VALUES[3],
    check: { kind: "file", path: "agent/lib/dark-factory/sandbox.ts" },
    expected: "execution goes through a replaceable seam",
    remediation: "Put execution behind a provider seam.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "remote-execution",
    pillar: 5,
    label: "Remote containerised execution",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "file", path: "opensandbox-driver.ts" },
    expected: "work runs in a remote container",
    remediation: "Move execution off the developer machine.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "persistent-sessions",
    pillar: 5,
    label: "Sessions survive disconnect",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "file", path: "agent/lib/dark-factory/session-resume.ts" },
    expected: "a session resumes after a disconnect",
    remediation: "Persist sessions so they survive a restart.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "naming",
    pillar: 6,
    label: "Consistent naming",
    level: 3,
    points: AMM_POINT_VALUES[3],
    check: { kind: "file", path: ".cspell.json" },
    expected: "a naming and spelling convention is enforced",
    remediation: "Agree a convention and enforce it mechanically.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "file-size",
    pillar: 6,
    label: "Files under 500 lines",
    level: 3,
    points: AMM_POINT_VALUES[3],
    check: { kind: "file", path: ".jscpd.json" },
    expected: "no source file exceeds the agreed size",
    remediation: "Split the largest files along their boundaries.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "complexity",
    pillar: 6,
    label: "Functions under 50, complexity under 15",
    level: 3,
    points: AMM_POINT_VALUES[3],
    check: { kind: "file", path: ".mega-linter.yml" },
    expected: "complexity limits are enforced",
    remediation: "Enable complexity limits and reduce offenders.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "provider-seams",
    pillar: 6,
    label: "Provider-neutral seams",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "file", path: "docs/adr/0006-provider-neutral-seams.md" },
    expected: "providers are swappable behind seams",
    remediation: "Hide vendor specifics behind a seam.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "structured-logging",
    pillar: 7,
    label: "Structured logging",
    level: 2,
    points: AMM_POINT_VALUES[2],
    check: { kind: "file", path: "agent/lib/dark-factory/run-history.ts" },
    expected: "logs are structured and queryable",
    remediation: "Emit structured events rather than prose.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "run-ledger",
    pillar: 7,
    label: "Granular run history",
    level: 3,
    points: AMM_POINT_VALUES[3],
    check: { kind: "file", path: "agent/lib/dark-factory/run-history-store.ts" },
    expected: "every run is recorded with its outcome",
    remediation: "Record runs in a queryable ledger.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "diff-capture",
    pillar: 7,
    label: "Code diffs captured",
    level: 3,
    points: AMM_POINT_VALUES[3],
    check: { kind: "file", path: "diff-capture.ts" },
    expected: "the diff produced by a run is stored",
    remediation: "Capture and store the produced diff.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "distributed-tracing",
    pillar: 7,
    label: "Distributed tracing",
    level: 3,
    points: AMM_POINT_VALUES[3],
    check: { kind: "file", path: "otel.config.ts" },
    expected: "work is traced across process boundaries",
    remediation: "Add tracing so a run can be followed end to end.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "spend-events",
    pillar: 7,
    label: "Spend recorded per run",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "file", path: "agent/lib/dark-factory/usage-store.ts" },
    expected: "cost is attributed to the run that incurred it",
    remediation: "Record spend per run.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "secret-scanning",
    pillar: 8,
    label: "Secret scanning",
    level: 2,
    points: AMM_POINT_VALUES[2],
    check: { kind: "file", path: ".gitleaks.toml" },
    expected: "secrets are scanned for before commit",
    remediation: "Add secret scanning to CI.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "branch-protection",
    pillar: 8,
    label: "Branch protection",
    level: 2,
    points: AMM_POINT_VALUES[2],
    check: { kind: "file", path: ".github/workflows/ci.yml" },
    expected: "the main branch requires passing checks",
    remediation: "Require checks before merging.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "code-ownership",
    pillar: 8,
    label: "Code ownership rules",
    level: 2,
    points: AMM_POINT_VALUES[2],
    // cspell:disable
    // A FILENAME cannot be reworded the way prose can: this check has to name the real file, and the shared
    // dictionary is deliberately not taught the word. Same scoped pattern as docs/superpowers/writing-plans.md.
    check: { kind: "file", path: "CODEOWNERS" },
    // cspell:enable
    expected: "sensitive paths have declared owners",
    remediation: "Declare owners for sensitive paths.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "dependency-scanning",
    pillar: 8,
    label: "Dependency scanning",
    level: 2,
    points: AMM_POINT_VALUES[2],
    check: { kind: "file", path: ".github/dependabot.yml" },
    expected: "dependencies are scanned for advisories",
    remediation: "Enable dependency scanning.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "vault-injection",
    pillar: 8,
    label: "Ephemeral credential injection",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "file", path: "opensandbox-credential-vault.ts" },
    expected: "credentials are injected at runtime, never stored",
    remediation: "Vault credentials and inject them at runtime.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
  {
    id: "rls",
    pillar: 8,
    label: "Row-level security",
    level: 4,
    points: AMM_POINT_VALUES[4],
    check: { kind: "file", path: "db/migrations/006_df_rls_coverage.sql" },
    expected: "row-level security is enforced in the database",
    remediation: "Enable RLS with coverage.",
    source: "whitepaper: eight pillars, binary signals, points by level",
  },
];

/** Every signal in a pillar, in catalogue order. */
export function signalsForPillar(pillar: AmmPillarId): AmmSignalDefinition[] {
  return AMM_SIGNAL_CATALOGUE.filter((signal) => signal.pillar === pillar);
}

/**
 * The most points any repository can earn: everything present. The whitepaper's scale ends at L5 = 100, so this MUST
 * be 100 - any other total would make the top unreachable or let a repository overshoot it.
 */
export function catalogueTotal(): number {
  return AMM_SIGNAL_CATALOGUE.reduce((sum, signal) => sum + signal.points, 0);
}

/**
 * What each pillar is FOR, and the evidence behind this repository's level in it. Held beside the signals because
 * they answer different questions: a signal says whether one thing is true, a benchmark says what the pillar buys.
 */
export const AMM_PILLARS: Record<AmmPillarId, { name: string; benchmark: string; evidence: readonly string[] }> = {
  1: {
    name: "Style & Validation",
    benchmark: "Linters, type checkers and formatters catch errors instantly.",
    evidence: ["MegaLinter", ".cspell.json", "tsconfig.json", "tests/style-contract.test.ts"],
  },
  2: {
    name: "Build System",
    benchmark: "Deterministic build commands an agent can run before committing.",
    evidence: ["next.config.ts", "package-lock.json", "tests/dependency-pins.test.ts"],
  },
  3: {
    name: "Testing",
    benchmark: "Fast, hermetic unit and integration tests create tight feedback loops.",
    evidence: ["vitest.config.ts", "playwright.config.ts", "tests/dark-factory/pg-test-helpers.ts", "evals/"],
  },
  4: {
    name: "Documentation & Instructions",
    benchmark: "Explicit instructions capture the knowledge agents would otherwise lack.",
    evidence: ["AGENTS.md", "ARCHITECTURE.md", "docs/adr/", "app/documentation/reference/generators.ts"],
  },
  5: {
    name: "Dev Environment & Remote Execution",
    benchmark: "Reproducible, sandboxed, increasingly remote and persistent execution.",
    evidence: ["agent/lib/dark-factory/sandbox.ts", "opensandbox-driver.ts", "sandbox-reaper.ts"],
  },
  6: {
    name: "Code Quality",
    benchmark: "Modular code with clear boundaries keeps an agent inside its context window.",
    evidence: [".jscpd.json", "docs/adr/0006-provider-neutral-seams.md", "run-history-store.ts"],
  },
  7: {
    name: "Debugging & Observability",
    benchmark: "Structured logging, tracing and metrics give runtime visibility.",
    evidence: ["run-history.ts", "diff-capture.ts", "breaker-trip-recorder.ts", "slack-notification.ts"],
  },
  8: {
    name: "Security & Governance",
    benchmark: "Guardrails let agents move fast safely.",
    evidence: [".gitleaks.toml", ".checkov.yml", "opensandbox-credential-vault.ts", "db/migrations/006_df_rls_coverage.sql"],
  },
};
