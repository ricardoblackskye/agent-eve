# Production evals on `main`: the cost gate reserves a whole context window, and charges it

**Parent:** #637 — *"Main is red after merge 540e37a: Architect timeout flake | Production Evals (cost budget exhausted) | Price Drift (#635)"* — item 2
**Branch:** `fix/637-eval-cost-accounting` (cut from `main` @ `1fb2f36`)
**Date:** 2026-11-13
**Related:** #635 / PR #638 (item 3, merged) · #478 (closed `deferred` — concluded "operator action only"; this plan supersedes that conclusion with evidence) · #457 / ADR 0054 (reservation reaper) · ADR 0027 (prices are reservation ceilings) · ADR 0065 (budget accounting survives a cap change)
**Approach:** TDD, with the defect reproduced from measurements before any code changes.

## 1. Symptom

`main`'s `Production Evals` job fails while every other job is green:

```
✓ auth-invalid 1/1   ✓ multi-repo-config 2/2   ✓ frontend 3/3   ✓ webhook 5/5
✓ product-owner 1/1  ✓ release-notes-tool 2/2  ✓ model-check 1/1
✗ auth-valid  0/1   ✗ succeeded (0% < 100%): run failed (code: MODEL_SELECTION_FAILED)
✗ smoke       0/2   ✗ succeeded (0% < 100%): run failed (code: MODEL_SELECTION_FAILED)
Results: 7 passed, 2 failed (9 total)   Gates: 15 passed, 3 failed
```

Only the evals that RUN A TURN fail. `MODEL_SELECTION_FAILED` is the eve framework's wrapper for a throw from the dynamic model resolver (`agent/lib/dark-factory/governed-model.ts:52`), which runs the cost gate first — so the real refusal is a `CostRefusedError`.

## 2. Measurements (2026-11-13, read-only)

`df_cost_budgets`, orchestrator category, period `2026-11`:

| cap_usd | spent_usd | reserved_usd | call_count |
| --- | --- | --- | --- |
| 80 | 79.8962752 | ~0 | 127 |

`df_cost_reservations`, the four most recent orchestrator rows — note the **identical** amount each time:

| reservation | estimated_usd | settled |
| --- | --- | --- |
| `res-1794593046785-gxaugchhjfe` | 0.1072576 | true |
| `res-1794590494151-o3su4bcbgbb` | 0.1072576 | true |
| `res-1794589611346-a4yaekwnpgj` | 0.1072576 | true |
| `res-1794589605743-weoub7ghc5q` | 0.1072576 | true |

A locally reproduced turn (`POST /eve/v1/session`, then read the stream) reported real usage of **3,518 input / 59 output tokens**, and `spent_usd` rose by **exactly `0.1072576`** — the reservation amount, not the measured cost. That turn's real cost at the gate's own prices is about **$0.00037**.

## 3. Root cause — two defects

### 3.1 The reservation is a whole context window

`agent/agent.ts:49-53` builds the gate with `inputTokens: ORCHESTRATOR_CONTEXT_WINDOW_TOKENS`, and `agent/orchestrator-model.ts:32` sets that to **`1_048_576`**. The reservation is therefore `1,048,576 x input price + 8,000 x output price` — a worst-case bound for a call that is typically a few thousand tokens:

| model | reservation per turn | a ~3.5k/59 turn actually costs |
| --- | --- | --- |
| `deepseek/deepseek-chat` | **$0.1072576** | ~$0.0004 |
| `deepseek/deepseek-v4.1-flash` (production default) | **$1.2156** | ~$0.0042 |

`admit()` refuses when `spent + reserved + estimate > cap` (`cost-budget-store.ts:293-294`). With production reserving **$1.2156 per turn**, every turn is refused once the period's headroom falls below $1.22 — that is `spent > $78.78`. It is at **$79.90**. The effective ceiling is therefore ~$78.78, not $80, and the last ~1.5% of any cap is unusable by construction.

### 3.2 The charge is the reservation, not the usage

The reservation is settled with `null` when usage is not seen (`cost-gate.ts:143-145`), and the store then charges `reservation.estimatedUsd` (`cost-budget-store.ts:340`). Four consecutive reservations settled at *exactly* the estimate while the provider reported real usage for the same turn. So every turn is charged its worst case — roughly **25x** to **300x** what it actually cost, depending on the model — which is how $80 of cap was consumed by 126 calls.

The exact reason usage is not seen must be pinned in Task 1 rather than assumed: the AI SDK (`node_modules/ai/src/generate-text/stream-text.ts:1802`) puts **both** `usage` and `totalUsage` on the finish part, so either the wrapped model is not the instance eve calls, or the part shape differs from what `usageFromPart` matches (`governed-model.ts:77-81`).

## 4. Why this is a code fix, not a top-up

#478 concluded "operator action only, no code change required" and topped the cap up. The cap has since been spent again, which is the same failure recurring. The measurements above show the reason: turns are charged a worst-case bound they never come close to spending. Topping up treats the symptom and the cap will drain again at the same multiple.

## 5. Design

**Part A — charge what was measured.** Make the reservation settle from the provider's reported usage on the wrapped-model path, and make a genuinely missing usage distinguishable from a measured zero (today both collapse to "charge the estimate"). Verified by a test that fails on `main`.

**Part B — reserve against the call, not the model's window.** Size the pre-call reservation from the actual conversation, which IS available: eve passes `ctx.messages` to a `step.started` handler (see `node_modules/eve/docs/agent-config.md:77-80`), and the current handler ignores its arguments. Reserve `estimated prompt tokens + output bound`, with the estimate stated and its safety factor explicit, instead of a hardcoded 1M-token window.

- Keep it an UPPER bound (ADR 0027): a conservative tokens-from-characters estimate with a documented factor, and the existing `DEFAULT_MAX_OUTPUT_TOKENS` for the completion.
- Keep the window constant for what it is actually for — `modelContextWindowTokens` in the model selection — and stop using it as the reservation basis.
- Make the bound overridable (`DF_*` env) so an operator can tighten or loosen it without a deploy, following the file's existing convention.

**Deliberately not chosen:** attributing CI/eval traffic to its own budget category. It would unblock the evals, but it creates a per-request path into the budget that bypasses the production cap, which is a policy and security decision that should be taken on its own, not smuggled into a defect fix.

## 6. Tasks (TDD)

**Task 1 — RED: reproduce and pin the charge-equals-estimate defect.**
- Instrument the settle path (or drive it from the store) to establish where usage is lost on the wrapped-model path.
- A test that fails on `main`: a turn with reported usage charges the measured cost, not `reservation.estimatedUsd`.
- Reproduce end to end: a local turn against the shared store, showing `spent` rising by the measured cost. Note the current headroom is $0.1037, so a turn is refused before the fix — capture that refusal as the reproduction.

**Task 2 — GREEN: settle from usage (Part A)**, with the missing-usage case still charging the estimate as the fail-safe.

**Task 3 — RED: pin the reservation basis (Part B).**
- A test asserting the admission estimate for a small conversation is proportional to it, and nowhere near a whole context window.

**Task 4 — GREEN: reserve from `ctx.messages` + the output bound (Part B)**, threaded through `governed-model.ts` → `cost-gate.ts` → `cost-governor.ts::admit`, keeping the fail-closed behaviour for an unconfigured cap, an unpriced model, and an unavailable store.

**Task 5 — verify.**
- Local: the reproduced turn is admitted, charges the measured cost, and leaves the store consistent (`reserved_usd` returns to ~0, `spent_usd` moves by the measured amount, `call_count` increments).
- Full suite, `tsc --noEmit`, cspell.
- **The real evals**: dispatch or watch the `Production Evals` job after merge; the acceptance is `smoke` and `auth-valid` passing with no `MODEL_SELECTION_FAILED`. Do not claim it before reading the job.
- State plainly that the existing spent budget is NOT restored by this fix: it stops the drain and unblocks admission, and no top-up is included.

## 7. Acceptance criteria

- [ ] A turn's `spent_usd` rises by the measured cost, not by `reservation.estimatedUsd`, with a test that fails on `main`.
- [ ] The pre-call reservation is proportional to the call, not to a 1M-token window, and stays an upper bound.
- [ ] A missing usage report still charges the reserved estimate (fail-safe preserved).
- [ ] Fail-closed behaviour is unchanged for unconfigured cap / unpriced model / unavailable store.
- [ ] `smoke` and `auth-valid` pass on `main` with no `MODEL_SELECTION_FAILED`, read from the job — not inferred.
- [ ] The remaining spent budget for the period is stated, since this fix does not refund it.
- [ ] #637 is updated with the outcome; item 1 (the Architect timeout flake) stays open.

## 8. Risks

- **Changing money semantics.** Reservation behaviour is load-bearing for overspend protection; Part B must keep an upper bound and a documented factor, and the fail-closed paths must keep their tests.
- **Token estimation.** Estimating tokens from message text is approximate. The factor and its direction (always up) must be explicit, and an override must exist so an operator can correct it without a deploy.
- **A shared store.** Local runs use the same Postgres as production, so a verification turn consumes real budget. Keep verification turns few and report what they cost.
