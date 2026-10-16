<!-- markdownlint-disable MD013 -->

# Dark Factory — UAT bug fixes, local run against another repo (#373) Implementation Plan

**Goal:** fix the two defects that a real local run against `ricardoblackskye/WebFeedPOC#161` exposed, so that
a run against a repo other than agent-eve can complete.

**Architecture:** both defects are in the runner's *environment plumbing*, and both were invisible to the test
suite because CI mocks the model and the ledger. Neither is a multi-repo defect: the multi-repo behaviour was
the part that worked.

---

## What the UAT run actually proved

Before the bugs, because the boundary matters for scoping this issue:

```text
Target Repository      ricardoblackskye/webfeedpoc (from argument)   ← resolved, not hardcoded
Allowed Repositories   ["ricardoblackskye/webfeedpoc"]              ← allow-list read
[STEP 1] Fetching live User Story #161 from GitHub...               ← pulled an issue from ANOTHER repo
  Story Title          Dark Factory - Test Issue
[STEP 2] Updating ticket lifecycle label to 'df:running' and posting progress comment...
```

It failed **closed**: `df:failed` applied to WebFeedPOC#161, the reason posted on the ticket in R4's wording,
no branch, no PR, nothing written. So the fix target is narrow.

## Bug 1 — the model key is captured before `.env` is loaded (the 401)

**Confirmed by reading, not inferred:**

- `agent/chat-model.ts:9-11` builds the client at **module scope**: `createOpenAI({ baseURL, apiKey: ***_KEY ?? "" })`.
- `scripts/dark-factory-runner.ts:124` calls `initEnv()`, which is what loads `.env` — also at module scope,
  but **after** its own imports have been evaluated. ESM hoists imports, so `chat-model.ts` is evaluated first.
- Result: the client captures `apiKey: ***` and every request goes out unauthenticated. The log line
  `OpenRouter Key Present? true` reads the variable *later*, which is why it truthfully reports `true`
  while OpenRouter answers `Missing Authentication header`.

The same module-scope pattern exists in the subagents (`product-owner/agent.ts`, `release-manager/agent.ts`,
and any other `createOpenAI` call site), so this is one bug with several instances.

**Fix:** make the key a lazy read — `apiKey: *** => process.env.OPENROUTER_API_KEY` — so the client resolves it
at call time rather than construction time. That fixes the ordering for good instead of moving the load earlier
(which cannot be made reliable: a module cannot run code before its own imports).

## Bug 2 — a run is not recorded, and the warning names the wrong remedy

```text
[WARN] The run record could not be opened (the ledger refused the delivery); this run will not be recorded.
       Set DF_RUN_HISTORY_DRIVER to record runs.
```

`DF_RUN_HISTORY_DRIVER=sqlite` **was** set, so the advice is actively misleading. That message comes from
`run-record.ts:81-84`, the branch taken when `acceptDelivery` returns not-ok **with no error string**.

Untested hypotheses, in the order I will check them (a probe, not a guess):

1. the sqlite driver requires a path it accepts (`./.df-run-history.sqlite` is relative; the repo's other
   sqlite paths are validated);
2. the provider falls back to the fail-closed console store for some other unset requirement;
3. the atomic active-run claim (ADR 0026) refused it, which would be correct behaviour and a *message* bug.

**Fix:** whichever it is, the two real deliverables are (a) make the refusal state its **reason** instead of
deferring to a default string, and (b) make the recovery advice true for the case that actually happened. If
the cause is a legitimate refusal, the fix is the message, not the gate.

## Tasks (TDD, in order)

### Task 1 — the model client reads its key at call time

**Files:** `agent/chat-model.ts`; tests for the call sites.

RED: a test that sets `OPENROUTER_API_KEY` **after** the module is imported and asserts the client then sends
it. That is the exact failure — a construction-time read cannot pass it, and a lazy read cannot fail it.
GREEN: the lazy apiKey; then the same change at every other `createOpenAI` call site, with a source guard
asserting no call site passes `process.env.OPENROUTER_API_KEY` directly as a string.

### Task 2 — the ledger refusal says why

**Files:** `agent/lib/dark-factory/run-record.ts`, `agent/lib/dark-factory/run-history-provider.ts`; tests.

RED: a test asserting the not-ok path includes the store's own reason (and does not print advice that
contradicts the configured driver). GREEN: thread the reason through; correct the advice.

### Task 3 — diagnose the actual refusal, and fix the cause

Probe the provider with the exact env the UAT run used, then either fix a real cause or record it in the plan.
A legitimate refusal changes the message only.

## Validation

```text
npx vitest run                                   # whole suite
npx tsc --noEmit --incremental false
npx cspell --no-progress <changed files>
node node_modules/eve/bin/eve.js build           # the gate `npm run build` does NOT run
```

Then **re-run the same UAT locally** and, this time, get past planning: the same one-command invocation
against WebFeedPOC#161, with the key exported for the first attempt so the fix is proven separately from the
workaround.

## Files likely to change

- `agent/chat-model.ts` + other `createOpenAI` call sites
- `agent/lib/dark-factory/run-record.ts`, `agent/lib/dark-factory/run-history-provider.ts`
- `tests/dark-factory/*`

## Risks and open questions

1. **CI cannot reproduce bug 1.** The suite mocks the model, so the regression guard has to assert the *shape*
   (a lazy read) rather than the 401. A source guard plus a late-set-env test is the strongest available
   without mocking an ordering that only occurs in a real process.
2. **The ledger refusal may be correct behaviour.** If it is the active-run claim, the run genuinely should not
   be recorded twice, and only the message changes. I will say which, with the probe's output, rather than
   assume.
3. **The `.env`-from-cwd pattern stays.** It is what makes an isolated clone work; the bug was the ordering, not
   the location. Moving it would be a redesign this issue does not need.
