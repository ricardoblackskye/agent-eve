# 0028 — The sandbox execution backend is a fail-closed, configuration-selected seam

**Date:** 2026-10-13
**Status:** Accepted

## Context

The Developer Agent executes generated code through `WorkspaceTools` (`readFile`, `writeFile`,
`listFiles`, `runTests`). That interface was hard-wired at one call site
(`scripts/dark-factory-runner.ts`) to the runner's own filesystem via `createWorkspaceTools(process.cwd())`.

Epic #279 will eventually execute generated code inside an isolated OpenSandbox, with a coding-agent
CLI authoring inside it. Before any of that can land, the *execution* backend has to become a seam —
without which every later release would have to change the developer loop.

## Decision

Introduce a provider-agnostic execution seam (`sandbox.ts`, `sandbox-provider.ts`, `local-sandbox.ts`),
selected by `DF_SANDBOX_DRIVER`, and make it **fail-closed**:

- **Absence means today's behaviour.** An unset or blank `DF_SANDBOX_DRIVER` resolves to `local`. The
  feature is off by default and switched on through the environment, with no code change.
- **There is no boolean enable flag.** A boolean can default open; a driver *name* cannot. The knob
  names the backend rather than asserting that one exists.
- **An unknown value throws before any side effect.** It never falls back to something permissive.
- **The seam refuses rather than silently no-opping.** A sandbox that cannot execute throws on every
  operation. An operation that reports success without executing would let a run claim progress it
  never made — the same reasoning as "never report tests passed when nothing ran".
- **`local` delegates to `createWorkspaceTools`** instead of reimplementing it, so the existing
  guards (path traversal, symlink containment, extension allowlist, test-command allowlist) keep
  running and there is no second implementation to drift.

`WorkspaceTools` stays in `developer-agent.ts` and is imported as a **type only**; a type-only import
is erased at compile time, so the seam cannot form a runtime import cycle with the developer loop.

## Consequences

- R1 changes no behaviour: with the knob unset, the resolved backend is byte-for-byte the local
  workspace tools, and the full suite passes unchanged.
- A later release can add a remote driver behind the same interface without touching the developer
  loop; the `refusing` driver already exists as the default for "cannot execute".
- The failure mode of a misconfiguration is a loud refusal at startup, not a silent fallback — so a
  typo in the knob cannot quietly change where code executes.
- `dry-run` is deliberately not a "pretend everything succeeded" mode: it proves the seam is wired
  while still performing no work, and it refuses rather than fake a pass.
