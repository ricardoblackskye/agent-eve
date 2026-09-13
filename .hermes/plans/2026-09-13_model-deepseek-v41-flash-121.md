# Plan: Change Eve's LLM model to DeepSeek V4.1 Flash (#121 / #122)

**Status:** PLAN — awaiting user approval (AI-SDLC GATE 1)
**Branch:** `feat/model-deepseek-v41-flash-121` (off `origin/main` @ `b62fe72`)
**Type:** feature (config-default change + foundational model-verification harness)
**Closes:** #122 · **Refs:** #121

---

## Goal

Issue #121 asks to switch Eve's model to "DeepSeek V4.1 Flash". The generated
story #122 adds acceptance criteria: use the exact id `deepseek-v4.1-flash`,
apply it to **all** LLM requests, keep it env-configurable (no code change),
**include a fallback model if the new model is unreachable**, and **include
tests that verify new models don't degrade behavior**.

This plan does the switch AND builds a **foundational, reusable model-verification
harness** (per the user's request: "be creative about the model verification
process and testing as this will be a foundation for other work").

---

## Root cause / current state (verified)

Model resolution is **duplicated and inconsistent** across the codebase:

| Resolver | Current default | Env override |
|---|---|---|
| Root `agent/chat-model.ts` (`DEFAULT_MODEL_ID`) | `deepseek/deepseek-v4-pro` | `EVE_CHAT_MODEL` |
| `product-owner` subagent | `deepseek/deepseek-v4-pro` | `MODEL_NAME` |
| `sprint-reporter` subagent | `deepseek/deepseek-v4-pro` | `MODEL_NAME` |
| `pr-reviewer` subagent | `deepseek/deepseek-v4-pro` | `MODEL_NAME` |
| `release-manager` subagent | `nvidia/nemotron-3-ultra-550b-a55b:free` (intentionally different) | none |
| `scripts/pr-reviewer.js` | `undefined` (passes raw `process.env.MODEL_NAME`) | `MODEL_NAME` |

- **No single source of truth** — 4 files hardcode the old deepseek id. Drift risk.
- **No fallback mechanism** — if `deepseek-v4.1-flash` is unreachable, the request
  simply fails (the mock only kicks in when `OPENROUTER_API_KEY` is *unset*). The
  story requires an explicit fallback when the model is unreachable.
- `scripts/pr-reviewer.js` passes `process.env.MODEL_NAME` verbatim → sends
  `model: undefined` to OpenRouter when unset (latent bug; deepseek subagents
  default but this script does not).

### Exact model id (verified live)
OpenRouter's `/v1/models` catalog (445 models) lists exactly one match for
"deepseek v4.1 flash":
**`deepseek/deepseek-v4.1-flash`** (provider-prefixed, required for OpenRouter
routing). The story's bare `deepseek-v4.1-flash` is the DeepSeek-native id; through
OpenRouter it MUST be the prefixed form. The previous model's prefixed id is
`deepseek/deepseek-v4-pro` — that becomes the explicit fallback.

---

## Intended fix

### A. Single source of truth — `agent/model-config.ts` (NEW)
Export the canonical defaults so every resolver imports them (kills the 4
duplicated literals and prevents future drift):

```ts
export const DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash";
export const FALLBACK_MODEL_ID = "deepseek/deepseek-v4-pro";
// Optional override env names kept here so the contract is one place.
export const CHAT_MODEL_ENV = "EVE_CHAT_MODEL";
export const SUBAGENT_MODEL_ENV = "MODEL_NAME";
```

Add a **pure, testable** resolver:
```ts
// Returns the model id to use. If `unreachable` is true and a fallback is
// configured, returns the fallback; otherwise returns the primary.
// Never silently returns the old model unless `fallback` is explicitly set.
export function resolveModelId(opts: {
  primary?: string;
  fallback?: string;
  unreachable?: boolean;
  envOverride?: string | undefined;
}): string { ... }
```

### B. Wire resolvers to the shared default + fallback
- `agent/chat-model.ts`: `DEFAULT_MODEL_ID` → import from `model-config`; keep
  `EVE_CHAT_MODEL` override. Add fallback wiring: when the primary is unreachable
  (signalled by a new optional `unreachable` flag / `MODEL_FALLBACK` env), return
  `FALLBACK_MODEL_ID`. Mock fallback (no key) is unchanged.
- `product-owner`, `sprint-reporter`, `pr-reviewer` subagent `agent.ts`: replace
  the local `DEFAULT_MODEL = "deepseek/deepseek-v4-pro"` literal with
  `DEFAULT_MODEL_ID` from `model-config`. Keep `MODEL_NAME` override.
- `release-manager` subagent: **leave as-is** (intentionally Nemotron; not "the
  Eve model" the issue refers to). Document this decision in the plan/PR.
- `scripts/pr-reviewer.js`: default `process.env.MODEL_NAME || DEFAULT_MODEL_ID`
  (import via a tiny `model-config.js` shim or hardcode the id there) so it never
  sends `undefined`.

### C. Docs consistency
- `.env.example`: `EVE_CHAT_MODEL=deepseek/deepseek-v4.1-flash`,
  `MODEL_NAME=deepseek/deepseek-v4.1-flash` (update the default shown).
- `README.md`: model-default line already says `deepseek/deepseek-v4-pro` in two
  spots (line 99 table, line 310 PR-reviewer note) → update to v4.1-flash.

---

## Foundational verification harness (the "creative" part)

The user wants this to be a **foundation for other model work**. Three test layers:

### 1. Exact-id unit tests (replaces loose `toContain("deepseek")`)
- `tests/chat-model.test.ts` already exists; extend/adjust so the **default**
  resolves to the EXACT `deepseek/deepseek-v4.1-flash` (not just "contains
  deepseek"). `EVE_CHAT_MODEL` override honored.
- `tests/model-resolver.test.ts` (NEW): unit-tests `resolveModelId` pure fn —
  default, env override, **fallback-when-unreachable**, **no-fallback-when-unreachable
  (returns primary, does NOT silently return old id)**, fallback disabled when
  `fallback` undefined.
- `tests/subagent-model-source.test.ts` (NEW): asserts every subagent `agent.ts`
  imports `DEFAULT_MODEL_ID` from `model-config` (no remaining hardcoded
  `deepseek/deepseek-v4-pro` literal in resolver files) — guards against future
  drift. Mirrors the existing `product-owner-agent.test.ts` "does not hardcode"
  idea but across all subagents.

### 2. OpenRouter contract test (live, skippable) — `tests/model-availability.contract.test.ts` (NEW)
- `GET https://openrouter.ai/api/v1/models` (read-only, **no token, no spend**).
- Asserts the resolved primary id (`deepseek/deepseek-v4.1-flash`) is present in
  the live catalog.
- **Skips** when offline / network error / `MODEL_CONTRACT_OFFLINE=1` so CI is not
  flaky. This is the "creative" guard: we prove the id is *real on the provider*
  before deploy, not just a string we typed.
- This becomes the reusable pattern for ANY future model swap.

### 3. Model-identity eval (runtime proof) — extend `tests/model-check-id.test.ts`
- Assert the served `model.modelId` equals the exact id when `OPENROUTER_API_KEY`
  is set (already does `toContain`; tighten to exact). This is the story's
  "verified via response metadata or model identifier" AC.

### 4. (Optional, lightweight) non-degradation smoke
- The existing smoke eval already boots the agent and gets a response. We assert
  the response is served by the new model id (metadata). True "performance vs old
  model" comparison is out of scope (needs both models + measurable SLA); we
  instead assert the **capability contract** (tool-calling/subagent routing still
  work) is preserved — which the existing eval suite already covers.

---

## TDD phases

- **RED:** write the NEW tests first — `model-resolver.test.ts`,
  `subagent-model-source.test.ts`, `model-availability.contract.test.ts` — and
  tighten `model-check-id.test.ts` to exact id. Run them; confirm failures:
  - `model-resolver.test.ts` fails (module/function doesn't exist yet).
  - `subagent-model-source.test.ts` fails (hardcoded old id still present).
  - `model-check-id.test.ts` exact assertion fails (default still old id).
  - contract test skips (offline) or passes (catalog has the id).
  Commit RED.
- **GREEN:** create `agent/model-config.ts`, wire all resolvers, update
  `.env.example` + `README`, fix `pr-reviewer.js` default. Re-run: all new + existing
  tests pass; full `npm test` green; `tsc --noEmit` clean.
- **REFACTOR:** none needed beyond the shared module; keep tests green.

---

## Files likely to change

- `agent/model-config.ts` — **NEW** shared defaults + `resolveModelId`.
- `agent/chat-model.ts` — import default; wire fallback.
- `agent/subagents/{product-owner,sprint-reporter,pr-reviewer}/agent.ts` — import shared default (drop local literal).
- `scripts/pr-reviewer.js` — default `MODEL_NAME || DEFAULT_MODEL_ID`.
- `.env.example`, `README.md` — update default ids.
- `tests/model-resolver.test.ts` — **NEW**.
- `tests/subagent-model-source.test.ts` — **NEW**.
- `tests/model-availability.contract.test.ts` — **NEW** (skippable).
- `tests/model-check-id.test.ts` — tighten to exact id (existing).
- `tests/chat-model.test.ts` — tighten default assertion (existing).

---

## Validation

- `npx vitest run tests/model-resolver.test.ts tests/subagent-model-source.test.ts tests/model-availability.contract.test.ts tests/model-check-id.test.ts tests/chat-model.test.ts` → all pass.
- `npm test` → full suite green (no regressions; current suite green on merged #125).
- `npx tsc --noEmit` → clean.
- `npx -y cspell@8 --config .cspell.json agent/model-config.ts tests/*.test.ts` → 0 issues.
- Manual: `grep -rn "deepseek-v4-pro" agent/subagents tests` returns only the
  intentional fallback constant in `model-config.ts` (no stray old defaults).

---

## Risks / open questions

- **`release-manager` keeps Nemotron** — intentional, not "the Eve model". Flag in PR.
- **Contract test network dependency** — guarded by skip-on-offline so CI never hard-fails.
- **Fallback transport**: `resolveModelId` is a pure id resolver; the actual
  retry-on-HTTP-error lives in the AI SDK call. We make the *policy* explicit and
  testable (primary → fallback id when unreachable) without inventing untested
  transport middleware. If the user wants automatic HTTP-retry, that's a follow-up
  (would need an AI SDK wrapper) — out of scope here unless requested.
- **Exact id vs provider prefix**: story says `deepseek-v4.1-flash`; OpenRouter
  requires `deepseek/deepseek-v4.1-flash`. We use the prefixed form (the only one
  that routes) and document why.
- **cspell**: `v4.1`, `nemotron` may need dictionary entries if flagged.

---

## L1/L2 benchmarks & re-baselining (added after approval)

The model swap is guarded by live, skippable benchmarks:

- `tests/model-latency.bench.contract.test.ts` (L1) — streaming latency vs budget.
- `tests/model-quality.regression.contract.test.ts` (L2) — graded-prompt quality gate.
- `tests/helpers/model-bench.ts` — pure `assertLatencyWithinBudget` / `gradeStoryQuality`
  + `measureLatency`; unit-tested offline in `tests/model-bench-helpers.test.ts`.
- `tests/fixtures/model-baseline.json` — committed ceiling (30s) + quality gate + prompt.

**Re-baseline procedure (run once with a real key, then commit the number):**
```bash
export OPENROUTER_API_KEY=sk-or-...          # never commit
MODEL_BENCH_RECORD=1 npx vitest run \
  tests/model-latency.bench.contract.test.ts \
  tests/model-quality.regression.contract.test.ts
# copy printed totalMs into tests/fixtures/model-baseline.json latency.baselineMs
git add tests/fixtures/model-baseline.json && git commit -m "bench: re-baseline model latency"
```
After that, a future model slower than `baselineMs * tolerance` (1.5) FAILS the
latency test. `MODEL_BENCH_OFFLINE=1` forces the live tests to skip. This is
documented in the README "Model Performance & Quality Benchmarks" section.
