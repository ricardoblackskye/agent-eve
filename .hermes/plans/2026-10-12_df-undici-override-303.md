# Plan — #303: clear the 10 `undici` Dependabot alerts via a scoped override

**Branch:** `fix/df-undici-override-303`
**Issue:** [#303](https://github.com/ricardoblackskye/agent-eve/issues/303)

## The problem, restated from the alerts API

10 open alerts — 2 high, 5 medium, 3 low — all `undici`, all with
`first_patched_version = 8.10.2` and range `>= 8.0.0, < 8.10.2`.

**One pin causes all ten.** `eve@0.44.4` depends on **`undici: 8.9.0` exactly**, which sits inside the
vulnerable range. The other two copies in the tree are fine:

- `node_modules/jsdom/node_modules/undici@8.11.2` — safe
- `node_modules/undici@7.30.0` (the AI SDK path) — a different major, outside the range

`package.json` declares no `overrides`.

## Fix: a scoped `overrides` entry

```json
"overrides": { "eve": { "undici": "8.11.2" } }
```

then `npm install` to regenerate `package-lock.json`.

**Scoped to `eve` deliberately.** A bare `"overrides": { "undici": "8.11.2" }` would also drag the AI
SDK's `undici@7.30.0` up to 8.x — a **major** bump for a different consumer that has asked for 7.x.
The override must change exactly the copy that is vulnerable and nothing else.

**8.11.2, not 8.10.2:** it is the minimum patched line's next release and the version `jsdom` already
resolves to, so it is already in the tree and verified to install cleanly here.

## Why not upgrade `eve`

The latest `eve` (0.77.0) does pin `undici: 8.10.2` — the patched floor — so an upgrade would also
clear the alerts. But that is a **0.44 → 0.77 jump across 33 minor releases**, and **ADR 0011** states
eve is pinned and upgrades are deliberate rather than absorbed into a dependency bump. That belongs in
its own issue with its own eval verification, not in a security cleanup.

## T1 (RED) — make it regression-proof

A structural guard over `package-lock.json`: **no copy of `undici` resolved beneath `eve` may sit below
`8.10.2`**. It fails today (eve resolves 8.9.0) and passes once the override lands.

Why a guard and not just the bump: this exact failure mode — a nested copy that no top-level `npm ls`
draws attention to, silently widening a vulnerable range — is invisible until Dependabot files ten
alerts. A guard makes the next `eve` change that re-pins an old `undici` fail the build instead.

## T2 (GREEN)

1. Add the scoped `overrides` block.
2. `npm install`.
3. Prove the lock change is **only** the intended one: `git diff --stat package-lock.json` and a
   targeted diff of the `undici` entries. A lock diff that touches anything else is a mistake to
   investigate, not to accept.

## Verification

- `npm ls undici` — eve resolves 8.11.2, no 8.9.0 anywhere.
- The lock diff is confined to eve's `undici` entry.
- Full suite · `tsc` · cspell · Prettier · `npm run build`.
- **CI `Eve Evals` is the real "eve still works" check** — a patch bump inside 8.x should not disturb
  eve's fetch paths, but the evals are what proves it rather than my judgement.
- Dependabot re-scans after the merge and the 10 alerts close.

**Non-vacuity:** T1 must fail before the override, and pass after. Both runs recorded.

## Out of scope

Upgrading `eve` (its own issue, per ADR 0011) · the other dependency groups, which the open Dependabot
**PR #327** already covers (`next`, `sharp`, `source-map-js` — see #331).
