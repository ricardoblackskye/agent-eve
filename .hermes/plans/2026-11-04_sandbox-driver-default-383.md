# #383 — Invert DF_SANDBOX_DRIVER default so host tree requires explicit flag

## Goal
Fail‑closed inversion of the sandbox driver default: an unset or blank `DF_SANDBOX_DRIVER` must refuse rather than silently fall back to the local provider. This satisfies Pillar 5 (sandbox‑by‑default isolation) by making an unconfigured run loudly demand an explicit choice (`local` for host‑tree access, `opensandbox` for isolation). The change does not alter the behaviour when a driver is explicitly set; it only changes the default.

## Verified current state (from the tree before the change)

| File | What it does |
|------|--------------|
| `agent/lib/dark-factory/sandbox-provider.ts` | Returns the `local` provider when `DF_SANDBOX_DRIVER` is `""` or `"local"` (lines 73‑76). |
| `tests/dark-factory/sandbox-provider.test.ts` | Encodes that default in three assertions (expecting a `LocalSandboxProvider` for `""`/`" "`/`"local"`). |
| `.env.example` | Leaves `DF_SANDBOX_DRIVER=` blank (implicitly opting in to the host tree). |

The provider already refuses unknown drivers (lines 101‑103) – that is AC2 and needs no change.

## Approach
1. **Invert the default** – replace the `"" || "local" → local` fallback with a `SandboxConfigError` that names both ways out (`=local` to run on the host, `=opensandbox` to isolate).
2. **Update `.env.example`** – set `DF_SANDBOX_DRIVER=local` explicitly so a fresh copy still runs; this documents the required opt‑out.
3. **Adjust tests** – replace the three assertions that expected the local provider with tests that verify the refusal and that the error message mentions both options. Keep the existing unknown‑driver test (AC2) as‑is.
4. **Run the full suite** – ensure no other production or test code relied on the silent default (none did; the only call sites read the env and now correctly refuse when unset).

## Tasks (each task = RED first, then GREEN)

### Task 1 — Invert the sandbox‑provider default (AC1)
**Files**: `agent/lib/dark-factory/sandbox-provider.ts`
- RED: unit test expects the current behaviour (returns local for empty driver).  
- GREEN: replace the fallback with a throw that constructs `SandboxConfigError` whose message contains both `local` and `opensandbox`.

### Task 2 — Document the explicit opt‑out (AC1)
**Files**: `.env.example`
- RED: the file still has `DF_SANDBOX_DRIVER=` (blank).  
- GREEN: set `DF_SANDBOX_DRIVER=local` and add a comment explaining the #383 change and the soft dependency on #585 for reliable provisioning.

### Task 3 — Re‑encode the test expectations (AC1)
**Files**: `tests/dark-factory/sandbox-provider.test.ts`
- RED: three assertions that the provider is local for `""`/`" "`/`"local"`.  
- GREEN: replace them with:
  1. `expect(() => createSandboxProvider("")).toThrow(SandboxConfigError)`  
  2. Same for `" "` (whitespace‑only).  
  3. Same for `"local"` (to force explicit choice even when the value looks valid).  
  4. Add a fourth test that catches the error and asserts its message contains both `local` and `opensandbox`.

### Task 4 — Verify no regressions
Run `npm run lint`, `npm run typecheck`, `npm test`, and the repo's markdown/cspell checks.

## Acceptance criteria mapping (from the issue)

| AC | How it lands here |
|----|-------------------|
| AC1 – the host tree requires an explicit flag | Tasks 1‑3: default now throws, forcing the user to set `DF_SANDBOX_DRIVER=local` (host) or `=opensandbox` (isolated). |
| AC2 – unknown driver refused | Already satisfied at lines 101‑103; no change needed. |
| AC3 – cold‑start measurement | Out of scope for this change; requires a running sandbox (depends on #585). |
| AC4 – document the disconnect gap as unmet or implement it | Left open; this change does not decide whether to close the gap silently or loudly. |

## Risks and deviations to flag
- **No change to known drivers** – setting `DF_SANDBOX_DRIVER=local` or `=opensandbox` behaves exactly as before; only the default changes.
- **Call sites** – the only places that read `DF_SANDBOX_DRIVER` from the environment (`dark-factory-runner.ts`, `amm-scan-runner.ts`) now correctly refuse when the variable is unset. No other production or test code accessed the env directly.
- **Soft dependency on #585** – the literal “isolated by default out of the box” path still needs provisioning to work without a manually‑placed helm; that is #585’s binary‑acquisition work. This branch is not blocked by it – it makes the missing provisioning *visible* (the refusal tells you to choose) instead of silently running on the host without it.

## Out of scope
- The remote end‑to‑end proof (#344).
- Reply‑watching so a parked run resumes (#380).
- Scaling, pools and cost optimisation.
- Inverting the default run posture is *in scope* – this change does exactly that.

---
*Branch*: `fix/383-fail-closed-driver` (commit `4156afe`)  
*Related issues*: #383 (primary), #585 (soft dependency on provisioning reliability)  
*Plan file*: this document (`.hermes/plans/2026-11-04_sandbox-driver-default-383.md`)