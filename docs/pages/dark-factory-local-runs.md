<!-- markdownlint-disable MD013 MD049 -->

# Local runs: provisioning a local Dark Factory run (#404)

> A local run is provisioned deliberately, not discovered by refusal. See
> [ADR 0050](../../docs/adr/0050-df-local-runs-are-provisioned-deliberately.md) for the why; the command is below.

The `npm run df:local-run` launcher asserts **every** prerequisite up front, reports all of them in one block,
prepares a checkout of the **target** repository as the working directory, and only then spawns the runner. A park
is expected: the run posts a plan and waits for approval ([ADR 0041](../../docs/adr/0041-df-plan-approval-is-opt-in.md)).

**Source:** [`scripts/dark-factory-local-run.ts`](../../scripts/dark-factory-local-run.ts),
[`agent/lib/dark-factory/local-run.ts`](../../agent/lib/dark-factory/local-run.ts),
[`local-run-preflight.ts`](../../agent/lib/dark-factory/local-run-preflight.ts),
[`local-run-checkout.ts`](../../agent/lib/dark-factory/local-run-checkout.ts)

## The command

```bash
npm run df:local-run -- --repo ricardoblackskye/WebFeedPOC --issue 169
```

Optional flags: `--workspace-root <dir>` (default `<cwd>/df-workspaces`, documented under
[The workspace root](#the-workspace-root-501)), `--allow-remote-store` (accept a hosted store — see ADR 0050,
never disables CA verification), and `--resume` (continue the parked run that holds this issue's claim instead
of starting a fresh one).

## Resuming a parked run

A park is a wait, not an end state. The run holds the issue's claim until a human answers it, and `--resume`
is how it continues:

```bash
npm run df:local-run -- --repo ricardoblackskye/WebFeedPOC --issue 169 --resume
```

The preflight **inverts** its claim rule for a resume, because the two entry points have opposite
preconditions:

- a **fresh run** refuses while any claim is held — something else is already working that issue;
- a **resume** requires one, and only while that run is parked (`blocked`). A `running` run is a live worker,
  so resuming it would put two processes on one issue; a `queued` run has nothing to continue. Both refuse,
  naming the status. With no claim at all the launcher says there is nothing to resume and names the
  fresh-run command instead.

A resume reads the approved plan back off the ticket rather than asking the architect again (#365), and a bare
`--resume` with no reply is read as approval — the parked question advertises replying as the way to begin
(#378).

## Prerequisites, and the exact refusal each produces

The runner fails closed on any of these. The launcher names them **all at once** before running anything:

| Prerequisite                                           | Variable                                   | A missing one produces                           |
|--------------------------------------------------------|--------------------------------------------|--------------------------------------------------|
| GitHub token (clone + push)                            | `GITHUB_TOKEN`                             | `missing-github-token`                           |
| Provider key (runtime, never `.env.local`)             | `OPENROUTER_API_KEY`                       | `missing-provider-key`                           |
| Target on the allow-list                               | `DF_WORKER_ALLOWED_REPOS`                  | `repo-not-allowed`                               |
| Run-history store configured                           | `DF_RUN_HISTORY_DRIVER` / `…_DATABASE_URL` | `run-history-not-configured`                     |
| Control store configured                               | `DF_CONTROL_DRIVER` / `…_DATABASE_URL`     | `control-store-not-configured`                   |
| Store reached                                          | (TCP probe)                                | `store-unreachable`                              |
| Store is local, unless opted in                        | (host of the URL)                          | `remote-store-refused`                           |
| Sandbox seam up (when `DF_SANDBOX_DRIVER=opensandbox`) | `DF_SANDBOX_ENDPOINT` / `DF_SANDBOX_IMAGE` | `sandbox-not-configured` / `sandbox-unreachable` |
| No other run holds the issue's claim                   | (run-history)                              | `claim-held` *(R2 names the fix)*                |

### Store + sandbox checklist (the part that was discovered by refusal)

```bash
# 1. A LOCAL Postgres for the run record and control state (a hosted store's certificate aborts the park).
docker run -d --name df-cov-pg -p 5432:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=darkfactory postgres:16-alpine

export DF_RUN_HISTORY_DRIVER=postgres
export DF_RUN_HISTORY_DATABASE_URL="postgres://postgres@localhost:5432/darkfactory?sslmode=disable"
export DF_CONTROL_DRIVER=postgres
export DF_CONTROL_DATABASE_URL="postgres://postgres@localhost:5432/darkfactory?sslmode=disable"

# 2. The sandbox seam (reuse the repo's own helpers — it already knows the cluster).
npm run df:sandbox-up        # scripts/sandbox-server-up.sh
npm run df:sandbox-smoke     # probes the seam and the image in the cluster

export DF_SANDBOX_DRIVER=opensandbox
export DF_SANDBOX_ENDPOINT="http://127.0.0.1:18082"
export DF_SANDBOX_PROTOCOL=http
export DF_SANDBOX_IMAGE="df-sandbox-webfeedpoc:4"
```

### Secrets at runtime, never on the command line

`OPENROUTER_API_KEY` is **not** in `.env.local` on this host. Pull it from the deployment, read it into the
child environment, and delete the temp file before running:

```bash
vercel env pull "$LOCALAPPDATA/Temp/df378/ve.env"   # then: read the key, rm the file
export OPENROUTER_API_KEY="$(that value)"
npm run df:local-run -- --repo ricardoblackskye/WebFeedPOC --issue 169
```

The launcher never prints a secret value. The runner still fails closed on a missing key.

`.env.local` is resolved from the **agent repository root**, not from the working directory (#540), and a
shell-exported value always wins over the file. Two consequences worth knowing: a runner started directly
inside a target checkout still gets the agent's environment, and a *target* project's own `.env.local` is
never read — that file is that project's configuration, not our credentials.

## What the launcher does that you cannot see

- **Owns the working directory.** It prepares (or reuses) `~/df-workspaces/<repo>-<issue>` as a checkout of the
  *target* repository, then runs the child there. Discovery reads `process.cwd()`; running in the agent repo is
  how an earlier run silently scanned the wrong project.
- **Clones without persisting a credential.** The clone URL is always the clean `https://github.com/owner/repo.git`;
  the token travels in the git environment for that one invocation (`GIT_CONFIG_COUNT`), so it never lands in
  `.git/config` and never appears in a process list.
- **Refuses before spawning.** If any prerequisite is missing, the launcher prints the block above and exits 1
  *without* starting the runner — so a failure is one line, not a hang.
- **Names a parked claim.** If a prior run still holds the issue's claim, the refusal names the holder. Retiring
  it is #404 R2.

## The checkout is provisioned before the coding loop (#541)

A freshly cloned checkout has no `node_modules`, so the target's own test command (e.g. `npx vitest run`) dies
before collecting a single test. The coding loop would then report a failure no edit to the target's source can
fix, and the developer would burn its self-corrections on our environment.

To stop that, the launcher provisions the checkout it just cloned: `npm ci` when a lockfile is present,
`npm install` when only a `package.json` is, and nothing when neither (a repository that was never a Node project
is not fed `npm ci`). A reused checkout — a resume — is not re-installed, because it was already provisioned. The
plan's `summary` names the command so it is visible before the run starts.

If the install fails, the launcher reports it loudly and continues: the coding loop then reports its tests as
**unmeasured** rather than as a failing edit. A test command that could not even start — a missing binary, a
config that will not load, a package that is not installed — is unmeasured, never a verdict on the developer's
work, and it does **not** trip the self-correction breaker. A test run that started and failed is still a failure.

## The workspace root (#501)

The launcher clones the target into `<workspace-root>/<repo>-<issue>`. The root comes from `DF_WORKSPACE_ROOT`, or
`--workspace-root <dir>`, and otherwise defaults to **`<cwd>/df-workspaces`** — inside whatever repository you ran
the launcher from. That default is ignored by git, so a run does not leave the cloned target untracked in its own
checkout.

The root is **created when it is missing**, and that is load-bearing rather than tidy. The clone runs with `cwd`
set to the root, and Node reports a missing `cwd` as `spawn git ENOENT` — an error that names `git`, which sends
you to PATH for an answer that is not there. Three local attempts went that way before the real cause was found.
Creating the directory means a clean checkout can no longer fail that way.

## Failure shapes

- **Parked at the end?** Expected — the plan is on the issue awaiting approval (ADR 0041). Re-run after approving
  or retiring.
- **Refused with `remote-store-refused`?** Point at the local Postgres, or pass `--allow-remote-store`.
- **Refused with `claim-held`?** A previous run holds the issue. The refusal names the holder and the command:
  retire it with `npm run df:retire-claim -- --repo owner/repo --issue N` (see below).

## Letting go of a stopped run (#404 R2)

A run that stopped without finishing keeps holding its issue's claim (ADR 0026 — the claim is atomic), so the next
run for that issue is refused. R1's acceptance ended exactly there, and the only way past it was destroying the
ledger.

```bash
npm run df:retire-claim -- --repo ricardoblackskye/WebFeedPOC --issue 169 --reason "the process is gone"
```

The launcher reports a held claim in the **same one block** as every other prerequisite, and names this command, so
"wait, or retire it" is actionable rather than advice.

| exit | meaning                                                                                 |
|------|-----------------------------------------------------------------------------------------|
| `0`  | the claim is gone **and** the ticket's factory labels were reconciled                   |
| `2`  | the ledger let go, but the ticket still lies (a partial outcome must not read as clean) |
| `1`  | refused — a live holder, no claim, or an unavailable ledger                             |

**A live (`running`) holder is refused and nothing is touched**: work in flight is never cut out from under itself.
A parked holder **is** retired — a park is a wait, and the retirement is what stops it resuming. Retirement applies
no terminal label (`df:done`/`df:failed` describe an attempt's outcome; retirement is neither). See
[ADR 0051](../../docs/adr/0051-df-retiring-a-stale-claim-is-abandonment.md).
