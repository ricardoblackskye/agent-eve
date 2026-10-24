# Issue #454 — a `create` target is allowed not to exist

- **Date:** 2026-10-24
- **Branch:** `fix/plan-validator-create-targets-454`
- **Status:** implementing (TDD)

## Goal

The plan validator must not reject a `targetFiles` entry whose `action` is `create` merely because the path is absent from the repository's file list. A create target is *defined* as a file that does not exist yet.

## Why this is a defect, not a preference

The rest of the system already expects create targets to be new:

- `scripts/dark-factory-runner.ts:1225` — `if (action === "create") continue; // a create target is expected not to exist yet`
- `agent/lib/dark-factory/preservation-guard.ts:112` — `create` is exempt from the removed-lines ratio because "its existence is checked by the caller".
- `agent/lib/dark-factory/architect-agent.ts:935` — "A `create` action for a path that already exists is a contradiction: use `modify` instead."

Only `plan-validator.ts` ignores `action` in its existence loop, so it refuses a case every other layer handles.

## Evidence from live runs

10 runs against WebFeedPOC #172: 7 ok, 3 failed. Every failure proposed `src/pages/HomePage.test.jsx` with `action: "create"`; the validator rejected it as `target-missing` even though the plan was a legitimate create. The model then entered a repair loop that lost repository identity (#451) and drifted.

## The fix

In `agent/lib/dark-factory/plan-validator.ts` existence loop:

- Skip the presence requirement when `file.action === "create"`.
- Keep the requirement for `modify` and `replace`.
- Adjust the message so "cannot be modified" is not used for create.

## Tasks (TDD)

1. **RED** — in `tests/dark-factory/plan-validator-target-missing.test.ts`:
   - a plan whose only target is a `create` of an absent path is `valid: true`, no `target-missing` code;
   - a `modify` target on an absent path still fails with `target-missing` (existing behaviour preserved);
   - a mixed plan (`modify` existing + `create` absent) is valid.
2. **GREEN** — honour `action` in the existence loop.
3. Run the full suite, `tsc --noEmit --incremental false`, and cspell on changed files.

## Out of scope

- The prompt contradiction between "every path MUST exist" (`architect-prompt.ts:63`) and "every AC maps to a test file" (`architect-agent.ts:626`). That is a prompt-design question and will be decided after this mechanical fix; #454 records it.
- #450's diagnostics and #451's identity-free repair prompt.
