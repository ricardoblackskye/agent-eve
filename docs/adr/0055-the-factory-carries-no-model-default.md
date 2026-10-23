# 0055 — The Dark Factory carries no model default of its own

- **Date:** 2026-10-23
- **Status:** Accepted

## Context

Two files answered the question "which model does the agent use". `agent/model-config.ts` declares
`DEFAULT_MODEL_ID` as the single source of truth, and `.env.example` documents the same value. The
Dark Factory runner answered it a second time: `initEnv()` set `EVE_CHAT_MODEL` to a *different*
model whenever the variable was unset, and a second expression resolved the id for the cost
governor.

Because the force-set ran at module scope before any resolution, both resolutions inside the runner
agreed - on the legacy model. The factory therefore called, and priced, a model that
`model-config.ts` had already replaced, and the deployed agent used a different one. Nothing failed
loudly: the run reported a consistent id, and the price table priced it correctly, so the ledger was
internally coherent while the chosen model was wrong. The ceilings were the casualty: the legacy
model is priced roughly six times lower on input and eight times lower on output, so every reserve
was a small fraction of the true cost of the model the project intends to run.

This is the same shape as `DF_WORKER_ALLOWED_REPOS` (#348): a code default for an unset variable
made an unconfigured deployment look deliberate.

## Decision

The runner resolves its model through the canonical resolver and passes that resolved id to cost
governance. It carries no model default of its own, and `initEnv()` no longer sets
`EVE_CHAT_MODEL`. When the variable is unset, the resolver falls through to `DEFAULT_MODEL_ID`.

The model and its id are produced together, by `resolveChatModelWithId()`, so a caller cannot hold
an id that names a different model than the one it calls. The id the governor prices is the id of
the model object handed to the provider.

## Consequences

A deployment now selects its model in one place. Changing it is `EVE_CHAT_MODEL` or a one-line edit
to `model-config.ts`, never a second default discovered by reading the runner.

The factory's default model changes to the canonical one, which is a real behaviour change: quality
and latency for factory runs may move, and the change is reversible through `EVE_CHAT_MODEL` alone.
Cost ceilings now reserve against the model actually called, so the same numeric cap protects
roughly six to eight times less spend than it appeared to before - any operator who tuned a ceiling
around the old figure should re-check it.

A future call site that wants a different model must resolve its own pair rather than reuse one
resolved elsewhere, because the pairing is per resolution, not global.

`deepseek/deepseek-chat` remains in the price table. Removing a retained entry is a price-table
question and belongs to its own review, not to this decision.
