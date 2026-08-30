# Fix release notes not updating on PR merge (#39)

> **For Hermes:** Implement via test-driven-development (RED → write minimal GREEN code → verify).

**Goal:** Restore automated `releasenotes.md` updates when the Release Manager processes a merged PR. Fixes #39.

## Root cause (reproduced)

`agent/subagents/release-manager/tools/{read_current_notes,write_release_notes}.ts` both send a corrupted Authorization header:

```ts
authorization: *** ${token}`,
```

In JS source, `***` is the spread operator `*` followed by `* ${token}` — parsed as `**` (a numeric-looking expression) followed by the template literal `${token}`. The resulting header value is NOT `Bearer <token>`; GitHub rejects it with 401 on every GET/PUT, so the Release Manager can read or write nothing.

This is why merged PR #36 did not update `releasenotes.md` (the check apparently ran but the write silently failed at auth).

## Proposed approach

1. **RED** — run `tests/release-manager.test.ts` and watch it FAIL on the `authorization: Bearer ${TOKEN}` assertion.
2. **GREEN** — fix the corrupted line in both `.ts` files to `authorization: \`Bearer ${token}\```.
3. **Verify** — re-run the release-manager tests (GREEN) plus the full test suite.
4. **Commit + PR** — `fix: correct corrupted Authorization header in release notes tools`, open PR closing #39.

## Files to change

- `agent/subagents/release-manager/tools/write_release_notes.ts` (line ~in fetch headers)
- `agent/subagents/release-manager/tools/read_current_notes.ts` (line ~in fetch headers)

## Validation

```bash
npx vitest run tests/release-manager.test.ts -t "Bearer"
```
Expected: **2 passed**.

Full suite:
```bash
npm test
```
Expected: all pass.

## Risks

- No schema/behavior change — only a header-string fix. The `GH_RELEASE_TOKEN` env var and API endpoints are already correct.
