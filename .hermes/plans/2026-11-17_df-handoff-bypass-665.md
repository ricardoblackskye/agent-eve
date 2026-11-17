# Plan: forward the Vercel protection bypass on the Dark Factory session handoff

Story: #665

## Goal

Make the GitHub-label trigger able to start a run on a protected deployment. Today the handoff is the
last hop and the only one that fails, so the intended trigger path is dead on `agent-eve-gold`.

## Root cause (verified against a real trigger)

Applying `dark-factory` to ricardoblackskye/WebFeedPOC#223 fired the trigger correctly, recorded the
dispatch, applied `df:running`, and then failed at the handoff:

```text
issues/labeled  label=dark-factory   HTTP 503
{"ok":false,"message":"dark-factory trigger: failed",
 "runId":"2449607d-...","runStatus":"failed",
 "error":"the session handoff was rejected with status 401"}
```

`postHandoff` targets `${resolved.origin}/eve/v1/session`. `resolveApiOrigin` returns
`platform.context.apiOrigin`, which for the Vercel adapter is `VERCEL_URL` - **the deployment's own
public URL**. It sends exactly two headers:

```js
const headers = { "content-type": "application/json" };
if (deps.apiKey) headers.authorization = `Bearer ${deps.apiKey}`;
```

No protection bypass. Every sibling call site that targets the deployment forwards one:

| Site                                | Line    |
|-------------------------------------|---------|
| `app/api/eve/v1/[...slug]/route.ts` | 64-69   |
| `app/api/github/webhook/route.ts`   | 375-379 |
| `app/api/github/webhook/route.ts`   | 547-548 |

`VERCEL_PROTECTION_BYPASS` is confirmed active on **Production and Preview** on the deployment, so the
self-POST arrives as an unauthenticated request to a protected deployment and is answered `401`.

This went unnoticed because runs launched locally hand off to loopback, and `resolveApiOrigin` trusts a
loopback origin without any bypass - the local path never needed it.

## Intended fix

Forward the bypass on the handoff, sourced exactly as the sibling sites source it, and keep the Vercel
gate so a Vercel secret is never sent to a generic platform.

The value is resolved at the call site the way the existing sites resolve it - `VERCEL_PROTECTION_BYPASS`,
falling back to the incoming `x-vercel-protection-bypass` header or query parameter - and passed into the
dispatch as a new optional field on `EntryDeps`. `postHandoff` sends it only when it has a value, matching
how it already treats `apiKey`.

Confirm while implementing whether the webhook's existing sites gate on `platform.id === "vercel"` the way
the proxy route does; if they do, mirror that exactly rather than inventing a second convention.

## Tasks (TDD)

`EntryDeps.postSession` is already injectable - *"Injected transport for the session handoff (tests supply
a recorder)"* - so the whole change is drivable offline in `tests/dark-factory/entry.test.ts`.

1. **RED** - a test that runs a dispatch on the Vercel adapter with a bypass configured and asserts the
   recorded handoff request carries `x-vercel-protection-bypass`. It fails today, which is #665's 401.
2. **GREEN** - resolve the bypass at the call site and forward it from `postHandoff`.
3. **Controls**, which matter as much as the fix:
   - a **generic platform** sends **no** bypass, so a Vercel secret cannot leak to a non-Vercel origin;
   - the bypass **unset** sends no header, so an unconfigured deployment is unchanged;
   - the existing `apiKey` behaviour is untouched.

## Files likely to change

| Path                                                | Change                                                           |
|-----------------------------------------------------|------------------------------------------------------------------|
| `agent/lib/dark-factory/entry.ts`                   | `EntryDeps` field + forward the header in `postHandoff`          |
| `app/api/github/webhook/route.ts`                   | resolve the bypass at the dispatch call site, as its siblings do |
| `tests/dark-factory/entry.test.ts`                  | the RED/GREEN cases and the two controls                         |
| `.hermes/plans/2026-11-17_df-handoff-bypass-665.md` | this plan                                                        |

## Validation

- The new tests fail before the change and pass after it, with both controls green.
- The full suite and `tsc --noEmit` are clean.
- The local gate set: `standard`/eslint on the changed files, markdownlint and cspell on this plan.

**The acceptance gate is the deployed path, not the pull request.** After merge and redeploy, re-apply
`dark-factory` to a ticket and confirm the handoff succeeds and a run actually starts. The PR alone cannot
demonstrate that - the same reasoning as any fix whose behaviour depends on a deploy-time secret.

## Risks and open questions

- **A bypass is a secret.** Sending it to a non-Vercel origin would leak it, so the generic-platform
  control test is part of the change rather than an optional extra.
- **This unblocks the handoff, not necessarily the whole run.** The trigger has never reached a session on
  this deployment, so the next surprise may sit behind this one. Two known candidates: whether a session
  runs the out-of-band runner or the Dispatcher path (the open question from #664), and the stale-claim
  shape described in #660 if the failed run's claim was not released.
- **#223 currently sits at `df:running`** with the run recorded `failed`, so its label overstates reality.
  Since `df:running` is not a terminal label the trigger will fire again, which is what makes the
  acceptance test above possible.

## No ADR

This is a bug fix matching a pattern three existing call sites already establish. The rule that a Vercel
secret must not reach a generic platform is already documented with the platform adapter.

## Related

- #665 - this defect.
- #664 / #663 - the Tester and evidence work, and the open question about which pipeline runs.
- #660 - the stale claim a failed run may leave behind.
