# Issue #405 — the Architect plans against a workspace it can justify

- **Date:** 2026-10-23
- **Branch:** `fix/df-plan-workspace-405`
- **Status:** awaiting plan approval (GATE 1)

## Goal

Planning must read a checkout of the **target** repository, and must refuse rather than silently read
a different one. The Architect stops inferring its root from `process.cwd()` and is handed an explicit
workspace root that has been verified against the run's target.

## What I verified

The Architects's deps take a directory and the runner ignores it:

```ts
// architect-agent.ts:87 — the seam already accepts a root
listFiles: (dir: string) => Promise<string[]>;

// runner:407 — and the runner throws it away
listFiles: async () => scanWorkspaceFiles(process.cwd()),
```

The call sites pass `"."`, meaning "the workspace root" (`architect-agent.ts:794`, `:888`), so the
runner's closure is the only reason the root is implicit.

The local launcher is correct **by construction, and only by construction**:

- `runLocalRun` calls `planCheckout()`, which computes `<workspaceRoot>/<repo>-<issue>`, clones the
  target into it when absent, and sets the child's `cwd` to that path (`local-run.ts:78-115`).
- So a run started through `scripts/dark-factory-local-run.ts` does plan against the target.
- Nothing in the **runner** checks that. Invoke the runner directly from any other directory and it
  plans against that directory. That is exactly what happened in the #169 probe, where the refusal
  was correct and the input described `agent-eve` instead of WebFeedPOC.

Two facts make this fixable without cloning before planning:

1. `targetRepo` is resolved (and authorized) at runner line ~255, well before STEP 3 at line 405.
2. The intended plan-time root is already a real path in both routes: the launcher's checkout on the
   host, and `process.cwd()` when the runner is started correctly.

## Intended fix

Thread an explicit, **verified** workspace root, and refuse when it cannot be justified.

1. **New module `agent/lib/dark-factory/plan-workspace.ts`.**
   `resolvePlanWorkspace({ targetRepo, cwd, override, remoteOf })` returns
   `{ ok: true, path, source } | { ok: false, problems }`.
   - The candidate is `override` when given, else `cwd`.
   - It is accepted only when the candidate is a git checkout whose `origin` remote identifies
     `targetRepo`. Comparison tolerates the https form, the ssh form, a trailing `.git`, and case.
   - `remoteOf` is injected, so the check is testable with no filesystem and no network.
   - Refusal names the target, the directory, and the remote that was actually found, plus the two
     ways to fix it.
2. **The runner resolves it once, before STEP 3**, and prints it in the banner next to the target.
   A refusal stops the run with the same style as the other preflight gates, before any planning
   token is spent.
3. **The Architect deps honor their argument.** `listFiles(dir)` becomes
   `scanWorkspaceFiles(join(root, dir))` and `readFile(rel)` joins the same root, so the seam stops
   being decorative.
4. **An override for deliberate use:** `--workspace <dir>` argument, then `DF_PLAN_WORKSPACE`, with
   the same precedence order the other resolvers use. An override is still verified - it selects the
   candidate, it does not skip the check.

## Decision needed

**Which posture when the workspace cannot be justified?** I recommend refuse, because the harm is a
confidently wrong plan that reads as evidence: R1 numbers describe the wrong repository, and every
page-scoped story parks on a repository that was never the target. A warning would leave that intact
and only add a line to the log.

The risk is the deployed worker. If it plans from a directory that is not a checkout of the target,
this turns a silently wrong run into a refused one. I consider that correct, but it is a behavior
change in production and I would rather you decide it than assume it. The alternative, if you want
production untouched, is refuse locally and warn in the deployed environment - which I do not
recommend, because it keeps two different truths about the same run.

**Second question:** the issue's acceptance asks for a demonstrated run against WebFeedPOC, not a
unit test alone. That needs a real issue and a token. Do you want the live demonstration as part of
this change (I would need a scratch issue number on WebFeedPOC), or the code plus a documented
command for you to run?

## ADR

ADR **0056**: the Architect refuses a workspace that is not a checkout of the target. Records why an
inferred root is worse than a refused run, and that the check is on the remote, not on the path.

## Tasks (TDD)

1. **RED - the resolver refuses a wrong workspace.** Cases: a checkout of another repository is
   refused and the problem names both repositories; a checkout of the target is accepted; an
   accepted https remote and its ssh equivalent both match; a trailing `.git` and different case
   still match; a directory that is not a checkout is refused with its own reason; an override
   pointing at the target is accepted while an override pointing elsewhere is still refused.
2. **GREEN - the resolver.** Implement the module; no filesystem, no network, all inputs injected.
3. **RED - the deps honor their root.** Assert the Architect's `listFiles(".")` and
   `readFile(path)` resolve under the supplied root and not under `process.cwd()`, using a temp
   directory whose contents differ from the repository's.
4. **GREEN - thread the root.** Runner resolves the workspace, passes it to both deps, and refuses
   before planning when it cannot be justified.
5. **Guard on ordering.** A test asserting the refusal happens before any `generateText` call, so a
   misconfigured run cannot spend planning tokens before it fails.

## Files likely to change

- `agent/lib/dark-factory/plan-workspace.ts` (new)
- `scripts/dark-factory-runner.ts` — resolve and honor the root, banner line, refusal
- `tests/plan-workspace.test.ts` (new), `tests/dark-factory-runner-plan-workspace.test.ts` (new)
- `docs/pages/dark-factory-modules.md`, `docs/adr/0056-*.md`, `docs/adr/README.md`

## Validation

- Every new test watched failing first, for the right reason; RED trees verified to carry no
  implementation.
- Full suite green; `tsc --noEmit --incremental false` exit 0.
- cspell 9.1.1, markdownlint MD040/MD026, pinned markdown-table-formatter 1.6.1 all clean on changed
  files including this plan.
- ADR integrity and doc-drift guards green.
- A non-vacuity mutation: point the resolver's comparison at the wrong repository and confirm the
  guard test fails.
- The issue's own acceptance: a page-scoped run against WebFeedPOC whose plan reasons about
  WebFeedPOC files, per the decision above.

## Risks

- **Production posture**, discussed above: a worker that plans from a non-target directory starts
  refusing instead of producing wrong plans.
- The checkout must have an `origin` remote. A directory exported as a tarball, or a checkout whose
  remote was renamed, is refused even though its contents may be correct. That is deliberate (the
  remote is the only cheap evidence of identity) and the message tells the operator to use the
  override.
- A shallow clone still records `origin`, so the launcher's `--depth 1` clone passes.
- This does not move the checkout earlier: the launcher already clones before spawning, and a direct
  invocation is expected to supply a checkout. Cloning inside the runner remains out of scope, since
  that is a bigger change to the run lifecycle and #405 only requires the input to be correct.
