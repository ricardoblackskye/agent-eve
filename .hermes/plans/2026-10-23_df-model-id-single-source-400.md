# Issue #400 — one model id for the call and for the governor

- **Date:** 2026-10-23
- **Branch:** `fix/df-model-id-single-source-400`
- **Status:** awaiting plan approval (GATE 1)

## Goal

The model the Dark Factory actually calls and the model it reports to the cost governor must be
the same value, derived once. The factory must also stop silently choosing a different model from
the one `agent/model-config.ts` declares as canonical.

## What I verified (the issue's mechanism is wrong)

The issue says the two resolutions *disagree*. They do not disagree inside the runner. I traced it:

`scripts/dark-factory-runner.ts` calls `initEnv()` at module scope, before any model is resolved:

```ts
function initEnv(): NodeJS.ProcessEnv {
  // ... reads .env
  if (!process.env.EVE_CHAT_MODEL) {
    process.env.EVE_CHAT_MODEL = "deepseek/deepseek-chat";
  }
  return process.env;
}

initEnv();   // line 147, module scope
```

`resolveChatModel()` reads `envOverride: opts?.modelId ?? process.env.EVE_CHAT_MODEL`
(`agent/chat-model.ts:48`), and the runner's `modelId` is `env.EVE_CHAT_MODEL ?? "deepseek/deepseek-chat"`
(line 346). Because the force-set already populated the env var, **both** resolve to
`deepseek/deepseek-chat`. They agree, and they agree on the legacy model.

Measured facts:

| Fact                                              | Evidence                     |
|---------------------------------------------------|------------------------------|
| `EVE_CHAT_MODEL` is not set in `.env.local`       | name lookup, values not read |
| it is not in the deployed environment             | stated in the issue body     |
| so the force-set at line 141 is live              | `initEnv()` runs at line 147 |
| the canonical default is a different model        | `agent/model-config.ts:17`   |
| the documented env default is the canonical model | `.env.example:98`            |

```ts
export const DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash";   // model-config.ts:17
              // .env.example:98  EVE_CHAT_MODEL=deepseek/deepseek-v4.1-flash
```

## The defect, restated

Two distinct faults, both real:

1. **The runner overrides the canonical model.** `model-config.ts` says the agent uses
   `deepseek-v4.1-flash`; the runner replaces that with `deepseek-chat` whenever the env var is
   unset, which is the default case. `deepseek-chat` is retained in the price table for a model the
   agent no longer uses. So every factory run selects the legacy model.
2. **Nothing structurally stops the id from drifting.** The id is derived twice, by two different
   expressions. They agree today only because of the force-set. Delete or change either one and the
   priced id separates from the called id.

The cost consequence is the one the issue measures. The price table prices the two models very
differently:

| model                          | input per 1k | output per 1k |
|--------------------------------|--------------|---------------|
| `deepseek/deepseek-v4.1-flash` | 0.0006       | 0.0024        |
| `deepseek/deepseek-chat`       | 0.0001       | 0.0003        |

The table's own comment requires each price to be an **upper bound** for the model charged. Running
the legacy model makes the reserve ~6x too low on input and ~8x too low on output relative to the
canonical model, so the configured ceilings are effectively far looser than they read. That harm
reaches the ledger through model selection, not through a mismatched label, which is why #336's
price-table guard passes while this is still wrong.

A third, smaller fault: line 399 writes `` `Model: ${env.EVE_CHAT_MODEL}` `` into the issue body. It
prints a value today only because of the force-set, and would print `undefined` the moment the
force-set is removed.

## Intended fix

1. **Resolve once, build from that id.** Add `resolveChatModelWithId()` to `agent/chat-model.ts`
   returning `{ modelId, model }`, where the model is built from the resolved id.
   `resolveChatModel()` becomes a thin delegate so every existing caller keeps its behaviour and
   there is one resolution path.
2. **Use the pair at the runner's call sites.** `const { model, modelId } = resolveChatModelWithId()`
   and pass `modelId` to `runGovernedAgentCall`. Both governed call sites (the Architect's
   `generateText` and the in-process code author) already share the same `modelId`, so one
   resolution covers both.
3. **Remove the silent override.** Delete the `EVE_CHAT_MODEL` force-set from `initEnv()`. With it
   unset, the runner then uses `DEFAULT_MODEL_ID`, which is what `model-config.ts` and
   `.env.example` both declare.
4. **Report the resolved id, not the raw env.** The startup line and the issue-body line read the
   resolved `modelId`, so they stay truthful when the env var is unset.

## Decision needed

Step 3 changes which model the factory calls. I recommend removing the override, for three reasons:
`model-config.ts` is the declared single source of truth, `.env.example` already documents the
canonical model as the default, and the deployed agent (which never runs `initEnv()`) already uses
the canonical model, so removing the override makes the runner match production instead of
diverging from it.

The alternative is to keep `deepseek-chat` but make it explicit: set `EVE_CHAT_MODEL` in the
environment and delete the code default. That preserves current factory behaviour and still fixes
the drift, but it leaves the factory on a legacy model with ceilings that under-reserve by 6x to 8x
until someone re-prices or re-points it.

## ADR

ADR **0055**: the Dark Factory resolves its model through the canonical resolver and does not carry
its own default. Records why a second default is a defect rather than a convenience, and that
pricing/attribution follow the resolved id.

## Tasks (TDD)

1. **RED — resolution is single-valued.** Test `resolveChatModelWithId()` with `EVE_CHAT_MODEL`
   unset returns `modelId === DEFAULT_MODEL_ID`; with it set returns that value for both; and the
   returned `model` is built from the same id. Also a guard case: with the env var unset, the id is
   not any model absent from `modelPriceTable`.
2. **GREEN — the seam.** Implement `resolveChatModelWithId()`; delegate `resolveChatModel()` to it.
3. **RED — the runner does not override.** Test the runner's env initialization leaves
   `EVE_CHAT_MODEL` absent when it was absent, so the resolved id is the canonical one. This is the
   case that fails on the current code.
4. **GREEN — drop the force-set** and switch the two call sites plus the two report lines to the
   resolved pair.
5. **Anti-drift guard.** A test asserting the id passed to `runGovernedAgentCall` equals the id of
   the model handed to `streamText`, so the two cannot separate again without a failure.

## Files likely to change

- `agent/chat-model.ts` — the `resolveChatModelWithId()` seam
- `scripts/dark-factory-runner.ts` — remove the force-set, use the pair, fix both report lines
- `tests/chat-model.test.ts` or a new focused test file — resolution cases
- `tests/dark-factory-runner-*.test.ts` — the no-override case and the anti-drift guard
- `docs/adr/0055-*.md` and `docs/adr/README.md` — the ADR and its index entry

## Validation

- Every new test watched failing before the code that satisfies it.
- Full suite green, `tsc --noEmit --incremental false` exit 0.
- `cspell@9.1.1` clean on every changed file including the plan and the ADR; markdownlint MD040 and
  MD026 clean; pinned `markdown-table-formatter@1.6.1` clean.
- Reservation direction re-checked after the change: with the canonical id the reserve must be an
  upper bound for that model, not the looser legacy figure.

## Risks

- Step 3 is a real model change for factory runs. Quality and latency may move; the change is
  config-reversible with `EVE_CHAT_MODEL` if the canonical model is worse for planning.
- The two governed call sites share one `modelId` today. If a future call site wants its own model,
  it must resolve its own pair rather than reuse this one — the anti-drift guard is per call site.
- `deepseek/deepseek-chat` stays in the price table. Removing an entry is out of scope here and
  belongs to a price-table review.
