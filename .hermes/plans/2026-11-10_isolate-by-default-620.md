# Plan: #620 — Complete #383 AC1: flip unconfigured default to isolate (opensandbox)

**Issue:** ricardoblackskye/agent-eve#620 (child of #383, Pillar 5)
**Branch:** `feat/620-isolate-by-default` (off `origin/main` @ f8ea162)
**Approach:** TDD — unit tests in `tests/dark-factory/sandbox-provider.test.ts` lead the change.

## Why
#383's headline Pillar-5 signal is *"an unconfigured run is isolated by default; the host tree
requires an explicit flag."* The explicit-flag half landed in #587 (an unset/blank
`DF_SANDBOX_DRIVER` now **refuses**). The "isolated by default" half was assigned to #597, but
#597 closed prematurely — it only shipped the AC3 cold-start docs (PR #598). Verified against
`main`: `agent/lib/dark-factory/sandbox-provider.ts` still throws `SandboxConfigError` on an
empty driver. The blocker (#585 CLI contract, #603 binary acquisition) is now **CLOSED**, so the
flip is implementable.

## Current behaviour (`sandbox-provider.ts`)
```ts
const requested = (env.DF_SANDBOX_DRIVER ?? "").trim();
...
if (requested === "") {
  throw new SandboxConfigError(
    "DF_SANDBOX_DRIVER is not set. An unconfigured run must not default to the host tree (#383): ...");
}
if (requested === "local") return createLocalSandboxProvider();
if (requested === "dry-run") return createDryRunSandboxProvider();
if (requested === "opensandbox") { return createOpenSandboxProvider(...); }
throw new SandboxConfigError(`Unsupported ...`);
```

## Target behaviour
An empty/unset `DF_SANDBOX_DRIVER` resolves to `opensandbox` (isolate) instead of refusing.
- `=local` → host (explicit opt-out, unchanged).
- `=dry-run` / `=opensandbox` → unchanged.
- unknown value → still `SandboxConfigError` naming both ways out (unchanged).
- Vault gate (`DF_SANDBOX_VAULT_ENABLED`) stays fail-closed; with no explicit driver it now
  resolves to `opensandbox`, which *satisfies* the gate (vault needs opensandbox, and the default
  is now opensandbox) — so it no longer throws on this case.

## Implementation (TDD order)
1. **Test first** — rewrite the `#383 the host tree requires an explicit flag` block and the
   vault-no-driver test in `tests/dark-factory/sandbox-provider.test.ts`:
   - `isolates by default when DF_SANDBOX_DRIVER is unset` →
     `expect(createSandboxProvider({}).driver).toBe("opensandbox")` and `provider.isolated === true`.
   - `isolates by default on empty/whitespace value` → same assertion for `""` / `"  "`.
   - `host tree still requires an explicit flag` → `DF_SANDBOX_DRIVER=local` selects host
     (`driver === "local"`, `isolated === false`).
   - `names both ways out on an UNKNOWN driver` (changed trigger: use `"bogus"`, not empty) →
     throws `SandboxConfigError` with `/DF_SANDBOX_DRIVER=local/` and `/DF_SANDBOX_DRIVER=opensandbox/`.
   - vault block: `vault gate set with no explicit driver resolves to opensandbox` →
     `createSandboxProvider({ DF_SANDBOX_VAULT_ENABLED: "1" }).driver === "opensandbox"`
     (replaces the old `refuses when the gate is set with no driver configured` test).
   - Unchanged tests: `=local`, `=dry-run`, `=opensandbox` selection, unknown-value throws
     naming supported values, vault+local refuses, blank gate = off, `SUPPORTED_SANDBOX_DRIVERS`.
2. **Implement** in `agent/lib/dark-factory/sandbox-provider.ts`:
   - `const requested` → `let requested`.
   - Replace the empty-throw block with:
     ```ts
     // #383 / #620 — ISOLATE BY DEFAULT. An unset/blank driver reaches a sandbox (opensandbox)
     // instead of refusing. The host tree still requires explicit `=local`; an unknown value still
     // refuses below. Fail-closed happens downstream: opensandbox creation is lazy and refuses when
     // no sandbox is reachable.
     if (requested === "") requested = "opensandbox";
     ```
   - Update the header comment ("Still outstanding from #383's AC1 … Until then an unconfigured
     run refuses") to state the default is now isolation (and note #585 is closed).
   - Update the inline `#383 — REFUSE on absence` comment to reflect the flip.
3. **`.env.example`** — see Q1.
4. **Doc-drift guard** — run `env-docs.test.ts`, `sandbox-docs-drift.test.ts`,
   `sandbox-cli-docs.test.ts`, `definition-of-done-ac.test.ts` (anything asserting the old
   "unset refuses" behaviour) and update assertions/comments to match isolate-by-default.

## Decisions (resolved 2026-11-10)
- **Q1 — `.env.example`:** Set `DF_SANDBOX_DRIVER=opensandbox` so the shipped example isolates by
  default (consistent with the new default).
- **Q2 — Fail-closed:** Minimal — unset → opensandbox provider (lazy); rely on opensandbox-driver's
  existing creation-time failure. No eager cluster check at resolution.
- **Q3 — Scope:** Core flip only — code + `.env.example` + unit tests. No e2e/live-cluster proof.

## Out of scope
- AC2 (unknown value refused) — already satisfied.
- AC3 (cold-start docs) — done in #598.
- AC4 (disconnect gap) — documented as unmet in #383; recovery in #380.

## Verification
- `npm run test` (vitest) green, including the rewritten sandbox-provider tests.
- `npx tsc --noEmit` (or repo typecheck script) clean.
- Doc-drift tests updated and green.
