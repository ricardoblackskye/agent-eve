# #582 — Dark Factory Installer setup (Phase 2 of #584)

- **Parent epic:** #584 (Portfolio Epic: Windows setup program for Eve and the sandboxes)
- **Status:** planning — opt-in approval required (any comment = plan feedback, not approval)
- **Branch:** `feat/582-dark-factory-installer` (based on `origin/main` @ `5211cf8`)
- **Trigger label:** `dark-factory`

## The boundary (from #584 — do not violate)

The Windows program (the .NET 8 GUI that installs the Docker configuration + clusters and
launches Eve) **does NOT live in this repo**. agent-eve owns the CLI contract it calls; the
program owns prerequisite detection (WSL2 / Docker / virtualization), binary acquisition + PATH,
orchestration UX, state, retry, and the GUI itself.

So #582's agent-eve deliverables are the **CLI-side readiness items** below. The GUI exe is
tracked by this issue but is built in its own repo. If the GUI is to be scaffolded *here*, that
needs a new repository (separate authorization) and is explicitly out of scope for this branch.

## Current state (what already exists)

- **#585** — one headless entry point `npm run df:sandbox-up` with flags only, stable exit codes
  (one per failure class), NDJSON on stdout / prose on stderr, state-file idempotency, and a
  read-only `--check`. Merged.
- **#603** — binary manifest ownership; the preflight verifies every required binary (version,
  opt-in digest) against `scripts/sandbox-vendor/artifacts.lock.json` and refuses before any
  mutation; added exit `15` (`prerequisites-mismatch`). Merged.
- **Gap:** the CLI exposes **no `--version` / version declaration**, so the "version coupling"
  open decision from #584 is still unresolved on the agent-eve side.

## Acceptance criteria

- **AC1 (version coupling):** the CLI exposes a stable version the external program can read, and
  the coupling policy is documented — the program (separate repo) will declare a minimum Eve
  version and refuse a checkout it does not support. Closes the agent-eve half of the #584
  version-coupling decision.
- **AC2 (GUI contract pinned):** a focused suite proves the CLI behaves as the GUI expects —
  NDJSON on stdout, prose on stderr, one exit code per failure class, `--check` returns structured
  results, no secret on argv. Reuses #585/#603 behaviour and pins it so a future change cannot
  silently break the program's integration.
- **AC3 (integration docs):** `dark-factory-local-runs.md` gains a "For the Windows program"
  section: the exact invocation (`npm run df:sandbox-up -- [flags]`), where the event schema
  lives, and the exit-code table — so the program integrates without screen-scraping prose.
- **AC4 (optional, reviewer's call):** commit a machine-readable event schema
  (`agent/lib/dark-factory/sandbox-event-schema.json`) the program can load directly, removing any
  need to parse NDJSON shape from docs.

## Tasks (TDD, RED → GREEN)

- **T1 — version declaration.** Add `--version` (accepted by the parser, excluded from the
  secret/unknown-flag paths) that prints the package version. **RED:** a test asserting `--version`
  is accepted and prints a semver. **GREEN:** behaviour + a line in the coupling doc. This is the
  agent-eve half of version coupling; the program's min-version enforcement lives elsewhere.
- **T2 — GUI contract suite.** New `tests/dark-factory/gui-contract.test.ts` asserting the four
  contract properties (AC2) against the in-process CLI modules — deterministic, no subprocess.
  **RED:** assertions fail. **GREEN:** pass. Reuses the NDJSON/exit-code helpers from #585/#603.
- **T3 — integration docs.** `dark-factory-local-runs.md` "For the Windows program" section.
  **RED:** a doc-drift guard fails (no section). **GREEN:** present + guard passes.
- **T4 — optional schema artifact (AC4).** Commit the event schema if the reviewer wants it.
- **T5 — PR.** Open `feat/582-dark-factory-installer` → `main`, referencing #582 and the #584
  boundary, quoting the version-coupling decision.

## Risks / notes

- **R1:** the bulk of #582 (the .NET GUI) is out-of-repo. This plan limits agent-eve scope to the
  contract + readiness the GUI depends on. Scaffolding the GUI here would violate the epic's own
  boundary and needs a separate repo.
- **R2:** version coupling is a *decision*. T1 delivers only the agent-eve half (expose version);
  the program's min-version refusal is its own concern.
- **R3:** T2 tests in-process modules, not a spawned `df:sandbox-up`, to stay fast and flake-free
  in CI (consistent with how #585/#603 were verified).

## Release split

Single PR. Agent-eve readiness lands together; the GUI itself is a follow-up in its own repo.
