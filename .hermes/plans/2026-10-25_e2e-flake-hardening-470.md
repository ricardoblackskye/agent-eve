# Plan — harden the flaky Documentation E2E spec (#470)

## Problem

While verifying the Next.js 16.4.3 upgrade (#459), a cold `npx playwright test` run failed 2 of 26 specs. Both
passed on a warm rerun, so neither was a logic failure — but chasing them showed they are not the same kind of
problem, and only one belongs in this change.

| spec                            | assertion                                        | cause                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/documentation.spec.ts:92`  | `page.getByText(/Eve/i).first()` must be visible | **Too broad.** Mermaid injects a hidden `<style>` whose text also matches `/Eve/i`, so `.first()` resolves to a node no reader can see. Fixed here.                                |
| `e2e/dark-factory-runs.spec.ts` | the ledger renders rows, then the detail grid    | **Harness design.** Playwright's `webServer` runs `npm run dev`, so every route compiles on first request — 25-37s on this machine, against a 15s `expect` timeout. Split to #473. |

## Why the documentation assertion is weak, not just flaky

A test named "content previously on /architecture is still served" should require text a reader can actually see.
`getByText(/Eve/i).first()` accepts a hidden `<style>` tag as proof that content is served.

## Change

`e2e/documentation.spec.ts` — scope to the rendered article and require visibility:

```ts
const article = page.locator(".architecture-container");
await expect(
  article.getByText(text).filter({ visible: true }).first(),
  `${text} should appear in the rendered documentation`,
).toBeVisible();
```

`.architecture-container` already anchors the sibling documentation specs (`.architecture-container h1`), so this
uses the established seam rather than inventing a selector.

## Deliberately out of scope

The runs spec. Asserting the evidence rather than the bare `.df-detail-grid` class is a genuine improvement, but it
does **not** make those specs pass on a cold tree: they fail earlier, at the ledger assertions, because the first
list call needs 26.1s of compile (`application-code: 355ms`). Addressing that means changing how the suite pays
compile cost — warm the routes in setup, or serve a production build — which is a harness decision. Filed as
**#473** with the measurements.

Also deliberately not changed: `fullyParallel`, the global `expect.timeout`, local `retries`. Relaxing those would
hide the class of problem rather than address it.

## Verification

- Docs spec passes on a **genuinely cold** tree (no `.next`, fresh `npm ci`). All 5 documentation specs passed in
  that run, `/architecture` content included, in 5.8s.
- The four runs-spec failures in that same cold run are the subject of #473, not evidence against this change.

## Risk

Low: one test-only assertion, scoped to an existing container selector. If the rendered article is renamed the
assertion fails loudly rather than silently passing on a hidden node.
