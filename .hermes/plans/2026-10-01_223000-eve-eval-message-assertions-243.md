# Unblock #226: migrate the eval reply assertion to `messageIncludes` (#243)

**Branch:** `dependabot/npm_and_yarn/npm_and_yarn-7c8d7e3be4` (already merged up to `main`)
**Issue:** #243 — blocks PR #226 and the `next` RCE fix

## Goal

Get PR #226 green so the critical `next` security bump can land, by migrating the
one eval assertion that the newer `eve` broke.

## Root cause (verified against the installed types)

`eve@0.69.0` — installed by #226's regenerated lockfile — **removed
`EveEvalContext.reply`**. `send()` now returns an `EveEvalTurn`, and the assertion
surface moved onto it.

From `node_modules/eve/dist/src/evals/types.d.ts`:

```ts
interface EveEvalContext<TContext = unknown> extends EveEvalAssertions {
  send(message, options?): Promise<EveEvalTurn>;   // was void; now returns the turn
  ...
}

interface EveEvalTurn extends EveEvalAssertions, EveEvalOutputAssertions {
  readonly message: string | undefined;           // raw reply text
  readonly status: "completed" | "failed" | "waiting";
  ...
}

interface EveEvalAssertions {
  succeeded(): AssertionHandle;
  messageIncludes(token: string | RegExp): AssertionHandle;   // <- the replacement
  calledTool(...); toolOrder(...); ...
}
```

So `t.check(t.reply, includes("you"))` was hand-rolling something the framework now
does first-class. The migration is one line:

```ts
// before
await t.send("Hello! What can you help me with?");
t.succeeded();
t.check(t.reply, includes("you"));

// after
await t.send("Hello! What can you help me with?");
t.succeeded();
t.messageIncludes("you");
```

`messageIncludes` lives on `EveEvalAssertions`, which `EveEvalContext` extends, so it
is callable on `t` exactly where `t.reply` was — no restructuring needed.

`EveEvalTurn.message` remains available if a raw string is ever needed, and
`t.check(value, assertion)` is unchanged for value-level assertions.

## The constraint that decides where this lands

**This fix must ship together with the `eve` bump — it cannot go on `main` alone.**
`messageIncludes` only exists in the newer `eve`; on `main`'s current lockfile it may
not exist at all, so applying this change there would break `main` instead of fixing
anything.

That is why it belongs on the dependabot branch, which is also the branch that
actually fails. It is not a separate branch off `main`.

## TDD

Per the workflow's mechanical-migration rule: this is a 1:1 API rename, so there is
no new failing test to write. The **RED anchor is the project type-check**:

- **RED** — `npx tsc --noEmit --incremental false` fails with
  `evals/smoke.eval.ts(9,15): error TS2339: Property 'reply' does not exist on type 'EveEvalContext<unknown>'`.
  Confirmed on the merged branch, and confirmed by CI on `821bbea`.

  **`npm run typecheck` alone gives a FALSE GREEN here.** `tsconfig.json` sets
  `incremental: true`, and a stale `tsconfig.tsbuildinfo` makes tsc skip
  re-checking `evals/smoke.eval.ts` — exit 0 locally while CI fails with the same
  error. Verify this task with `--incremental false` (or delete the build-info
  first), and never trust a bare `npm run typecheck` after a branch switch or a
  dependency change.
- **GREEN** — type-check passes, and the existing suite still passes.
- The assertion's *behaviour* must be unchanged: the eval still requires the agent's
  reply to mention "you".

## Tasks

1. Confirm the RED: `npm run typecheck` on the branch fails with the TS2339 above.
2. Replace the assertion in `evals/smoke.eval.ts` with `t.messageIncludes("you")`,
   and drop the now-unused `includes` import if nothing else uses it.
3. Check the other evals for the same pattern — `auth-valid.eval.ts` and
   `auth-invalid.eval.ts` do not use `t.reply`, so the blast radius should be one
   file, but confirm rather than assume.
4. `npm run typecheck`, `npx vitest run`, `npm run build`.
5. Push to the dependabot branch so #226 re-runs.
6. Add an ADR recording the assertion-API change.

## Files likely to change

| File | Change |
|------|--------|
| `evals/smoke.eval.ts` | `t.check(t.reply, includes("you"))` → `t.messageIncludes("you")` |
| `docs/adr/0011-*.md` + index | new — the eval assertion API change |

## Validation

- `npm run typecheck` — exit 0 (the RED anchor flipping). **Run it as
  `npx tsc --noEmit --incremental false`**: the repo sets `incremental: true`, and a
  stale build-info can report a false green by skipping changed files.
- `npx vitest run` — full suite green.
- `npm run build` — green.
- **CI on PR #226** — the real gate: `TypeScript` was the failing job; `Eve Build`,
  `Eve Evals` and `Playwright E2E` were all *skipped* behind it, so they will run for
  the first time on this push and could surface further fallout.
- Local Playwright is unreliable here (documented in `e2e-regression-discipline`), so
  expect to rely on CI for the e2e job.

## Risks / open questions

- **The skipped jobs are unproven.** `Eve Build`, `Eve Evals` and `Playwright E2E`
  have never run on this branch because TypeScript failed first. Fixing the type
  error is necessary but may not be sufficient — say so rather than declaring victory
  on a green `TypeScript` alone.
- **Why did `eve` move?** The dependabot group named `next`, `dompurify` and
  `undici`, yet `eve` changed version — so the lockfile regeneration floated it. That
  is worth confirming and recording, because it means *any* lockfile regeneration can
  move `eve` and break eval assertions again.
- **`messageIncludes` semantics.** It takes a `string | RegExp` and presumably
  asserts the reply contains it — matching the old `includes("you")` intent. Confirm
  it is a case-sensitive substring match, since `includes` was.
- **Dependabot may force-push.** It has already force-updated this branch once; if it
  rebases again our commit could be discarded, so the push should be re-verified.

## Out of scope

The docs epic (#232 legs), and #226's own version bumps — those are already correct
(`npm ci`: 0 vulnerabilities, `next` at `^16.3.6`).