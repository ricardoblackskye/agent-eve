# 0011 — eve is pinned; framework upgrades are not absorbed into dependency bumps

- **Date:** 2026-10-02
- **Status:** Accepted

## Context

A dependabot group opened to bump `next` — which carried a critical security fix
(remote code execution in `next/og` ImageResponse, tracked in PR #226) — along with
`dompurify` and `undici`. **Dependabot's bump commit also directly edited the `eve`
spec in `package.json` from `^0.44.0` to `^0.69.0`** — twenty-five minor versions —
even though the PR description listed only the three packages above and omitted
`eve`, so the framework jump was invisible until failures surfaced. (It was not a
lockfile float: a caret `^0.44.0` cannot resolve past `0.45.0`, so the spec itself
was changed.)

That single spec change produced two independent breakages, neither related to
the security fix the PR existed to deliver:

1. `EveEvalContext.reply` was removed, so `evals/smoke.eval.ts` failed to type-check.
2. Model selection began requiring `modelContextWindowTokens`, so the chat agent
   could not select its model and stopped replying — which failed the Playwright
   chat specs.

## Decision

Pin `eve` to the **0.44 line** and do not take the 0.69 upgrade as part of a
dependency bump. The security fix lands on its own, as a small change.

The 0.44 → 0.69 upgrade becomes its own deliberate task, carrying both migrations
and the investigation they need.

## Consequences

- A critical security fix is no longer held hostage to a framework upgrade, and a
  twenty-five-minor jump gets reviewed as what it is rather than as `chore(deps)`.
- The repository does not receive `eve`'s improvements until that deliberate upgrade
  lands. That is the accepted cost, and it is the reason this is recorded rather than
  assumed.
- **The pin is the protection.** Regenerating the lockfile can still move `eve` if
  the spec is loosened, so the spec range is load-bearing and should not be widened
  without the upgrade work.
- The upgrade task must handle at least: the `reply` removal (its replacement is
  `EveEvalAssertions.messageIncludes`), and the model-context-window requirement on
  the **dynamic subagent** path — the orchestrator already supplies
  `modelContextWindowTokens`, but the resolver that registers
  `self-modification__agent` does not.
