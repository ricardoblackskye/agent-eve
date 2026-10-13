# Plan — #280: Dark Factory sandbox execution seam (R1 of #279)

**Branch:** `feat/df-sandbox-seam-279`
**Issue:** [#280](https://github.com/ricardoblackskye/agent-eve/issues/280) · parent epic [#279](https://github.com/ricardoblackskye/agent-eve/issues/279)
**Release:** R1 of 3 (R2 #281 author seam + gateway, R3 #282 credential vault)

## Preconditions — checked BEFORE planning

R1 needs **no external credentials**. It ships the execution seam with `local` + `dry-run` only;
the sandbox-backed driver is added in R2 (#281). So this release is implementable and fully verifiable
locally today — unlike R2, which is gated on the cost governor being live at the CLI's call site.

The repo has **no existing sandbox code** (no `DF_SANDBOX_DRIVER`, no seam): this is greenfield.

## Verified current state

| what | where |
|---|---|
| `WorkspaceTools` (readFile/writeFile/listFiles/runTests) | `agent/lib/dark-factory/developer-agent.ts:471` |
| `createWorkspaceTools(dir, commandRunner?, allowedExtensions?)` | `developer-agent.ts:504` |
| path-traversal + symlink containment | `resolveContainedPath`, from `developer-agent.ts:513` |
| extension allowlist (`ALLOWED_WORKSPACE_EXTENSIONS`) | `developer-agent.ts:482` |
| test-command allowlist (`npx vitest` / `npm test` / `npx tsc`) | `developer-agent.ts:678` |
| the ONLY call site to rewire | `scripts/dark-factory-runner.ts:348` (`createWorkspaceTools(process.cwd())`) |

## Goal

Introduce a provider-agnostic sandbox seam behind `WorkspaceTools` so the backend executing
generated code is **configuration-selected** rather than hard-wired to the runner's local
filesystem — with **zero behaviour change** when unset.

## Design

- **`agent/lib/dark-factory/sandbox.ts`** — `SandboxProvider` interface, the provider result
  (`{ tools: WorkspaceTools; isolated: boolean }`), a **refusing default** (throws; executes
  nothing), and a **`dry-run`** provider (`isolated: false`, every method a no-op that reports it
  did not execute).
- **`agent/lib/dark-factory/sandbox-provider.ts`** — `createSandboxProvider(env)`. Keys:
  | `DF_SANDBOX_DRIVER` | result |
  |---|---|
  | unset | `local` (today's behaviour) |
  | `local` | local adapter |
  | `dry-run` | dry-run provider |
  | anything else | **throws**, naming the supported values |
- **`agent/lib/dark-factory/local-sandbox.ts`** — delegates to the existing
  `createWorkspaceTools()`, so **all four guards keep running unchanged** (traversal, symlink,
  extension, test-prefix). Reproduces today's behaviour byte-for-byte.
- **Runner wiring** — resolve the provider instead of calling `createWorkspaceTools(process.cwd())`.

**Import-cycle decision (the issue's open question):** keep `WorkspaceTools` where it is and have
the seam `import type` it. A type-only import is erased at compile time, so the cycle cannot exist at
runtime; the factory lives in its own module as the issue asks. This avoids moving `WorkspaceTools`
and churning `developer-agent.ts` for a zero-behaviour release.

## Env toggle semantics

Off by default; **absence = today's safe behaviour**. There is deliberately no boolean "enable"
flag, because a boolean can default open. An unknown value throws **before any side effect**.

## Tasks (RED -> GREEN) — ALL DONE

**Outcome:** 4 new suites, 17 new tests. RED was a genuine RED: 12 tests failing against
real-signature stubs (the modules existed and threw `not implemented`), so Vitest COLLECTED and ran
them — not a "cannot find module" collection error masquerading as RED.

- **T1 DONE** — `refusing` provider: every operation throws `SandboxRefusedError`; asserted for all
  four methods, plus that the reason is named so a misconfiguration is diagnosable.
- **T2 DONE** — unset/blank -> `local`; explicit `local`; `dry-run` with `isolated: false`; unknown
  value throws naming `Supported values: local, dry-run`; and the supported set is exactly those two.
- **T3 DONE** — contract test drives the SEAM: read/write/list round-trip, byte-for-byte parity with
  `createWorkspaceTools` in both directions, and all four guards still fire through it.
- **T4 DONE** — runner resolves the provider at the single call site; a source guard asserts the seam
  is invoked exactly once and that the direct `createWorkspaceTools(process.cwd())` call is gone.
- **T5 DONE** — ADR 0028 + index row, three catalog rows, active `DF_SANDBOX_DRIVER=` row; the three
  repo guards (`doc-drift-guards`, `adr-integrity`, `env-example-coverage`) pass 20/20.

**Verification (all local):** full suite **2015 passed / 31 skipped** (was 1998/31 — the +17 is
exactly the new tests), `tsc --noEmit --incremental false` clean, `DF_PLATFORM_PROVIDER=generic
npm run build` exit 0, **cspell 0 issues across all 13 changed files**, repo guards 20/20.

### Two implementation notes found by the gates
- `tsc` rejected `NodeJS.ProcessEnv` as a parameter type: this repo augments `ProcessEnv` to require
  `NODE_ENV`, so a test fixture could not construct one. The factory now takes a one-property
  `SandboxEnv`, and its default is explicit (`{ DF_SANDBOX_DRIVER: process.env.DF_SANDBOX_DRIVER }`)
  — which also exposes the `process.env` read to the env-coverage guard.
- `dry-run` REFUSES rather than returning no-op successes. A dry run that reported "tests passed"
  without running anything is the same failure mode this repo already rejects elsewhere.

## Original task list (as planned)

1. **T1 — the refusing default (fail-closed).** RED: a provider that reports it cannot execute must
   make every `WorkspaceTools` method fail closed with zero side effects (no file read/write, no
   command). GREEN: implement it.
2. **T2 — `createSandboxProvider`.** RED: unset -> `local`, `local` -> local, `dry-run` -> dry-run
   with `isolated: false`, unknown -> throws naming supported values. GREEN: implement the factory.
3. **T3 — the local adapter is behaviour-preserving.** Run the EXISTING workspace-tool tests against
   the seam (the acceptance criterion says contract tests against the seam, not a hand-rolled mock),
   and assert each of the four guards still fires through the seam.
4. **T4 — runner wiring.** Resolve the provider in `scripts/dark-factory-runner.ts`, plus a
   source-level guard test pinning the call site (the run-finalizer pattern) so the seam cannot be
   silently unwired later.
5. **T5 — docs and the ADR.** `docs/adr/0028-df-sandbox-execution-seam.md` (why a seam, why
   fail-closed, why local-first), linked from `docs/adr/README.md`; a catalog row in
   `docs/pages/dark-factory-modules.md`; an active `DF_SANDBOX_DRIVER=` row in `.env.example`.

## Acceptance criteria (from the issue)

- Unset -> refusing/dry-run default, fail-closed, zero side effects.
- Unknown value -> throws before any side effect.
- `local` reproduces current behaviour; full suite + `tsc --noEmit --incremental false` green.
- Existing guards (path traversal, symlink, extension allowlist, test-command allowlist) still run.
- Contract tests run against the seam, not a mock of it.
- Docs: module page, `.env.example` rows, ADR linked from the index.

## Verification (all local)

Full `npx vitest run` · `npx tsc --noEmit --incremental false` · `DF_PLATFORM_PROVIDER=generic npm run build`
· **cspell over EVERY changed file** (`git diff --name-only ...`) including this plan and the ADR ·
`markdown-table-formatter`/`markdownlint` on changed markdown · then a PR against `main` for CI.

## Out of scope

No OpenSandbox adapter and no live sandbox calls (R2). No change to the authoring path, metrics or
control semantics.

## Risks / open questions

- The three repo guards (`doc-drift-guards`, `adr-integrity`, `env-example-coverage`) all fail CI if
  the catalog row, ADR index link, or `.env.example` row is missed — do T5 in the same change.
- `runTests` returns `{ passed, output }` while `CommandRunnerFn` returns
  `{ exitCode, stdout, stderr }`: the seam must preserve the existing mapping rather than invent a
  new shape.
