# 0011 — Eval assertions use the framework's assertion surface

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

`evals/smoke.eval.ts` asserted on the agent's reply by reaching into a property on
the eval context:

```ts
t.check(t.reply, includes("you"));
```

That worked until `eve` moved to 0.69.0, which **removed `EveEvalContext.reply`**.
The type-check failed with `error TS2339: Property 'reply' does not exist on type
'EveEvalContext<unknown>'`, blocking PR #226 — which carried a critical security
fix for `next` (`GHSA-vcvr-r3jv-pc5j`, RCE in `next/og` ImageResponse).

Notably, the dependabot group named only `next`, `dompurify` and `undici`. The
`eve` version moved because **the regenerated lockfile floated it**. So this was
not a consequence of the packages the PR claimed to change.

The replacement already existed: `EveEvalAssertions` — which `EveEvalContext` and
the new `EveEvalTurn` both extend — provides `messageIncludes(token: string |
RegExp)`.

## Decision

Assert on the agent's output through the framework's **assertion surface**, not by
reading context properties directly. The reply assertion becomes:

```ts
t.messageIncludes("you");
```

`EveEvalTurn.message` remains available when a raw string is genuinely needed, but
prefer the assertion helpers: they record a gate, whereas a bare property read
asserts nothing on its own.

## Consequences

- Assertions survive changes to the context object's shape, because they are the
  framework's declared contract rather than incidental properties.
- The migration had to ship **with** the `eve` bump, not before it: `messageIncludes`
  does not exist on the older `eve`, so applying it to `main` alone would have broken
  `main` instead of fixing the branch.
- **Every dependency bump is now a potential eval-assertion break.** A regenerated
  lockfile can move `eve` even when no `eve` change is requested, and the only signal
  is a type-check failure. Treat eval assertions as a known risk surface for
  dependency work, and read the type errors rather than assuming a bump is inert.
- This break was invisible to `npm run typecheck` locally: `incremental: true` plus a
  stale `tsconfig.tsbuildinfo` reported a **false green** while CI failed on the same
  code. Type-checks verifying eval changes must run with `--incremental false`.
