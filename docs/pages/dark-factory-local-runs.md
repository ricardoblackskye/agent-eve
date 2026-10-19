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

Optional flags: `--workspace-root <dir>` (default `$HOME/df-workspaces`),
`--allow-remote-store` (accept a hosted store — see ADR 0050, never disables CA verification).

## Prerequisites, and the exact refusal each produces

The runner fails closed on any of these. The launcher names them **all at once** before running anything:

| Prerequisite | Variable | A missing one produces |
|---|---|---|
| GitHub token (clone + push) | `GITHUB_TOKEN` | `missing-github-token` |
| Provider key (runtime, never `.env.local`) | `OPENROUTER_API_KEY` | `missing-provider-key` |
| Target on the allow-list | `DF_WORKER_ALLOWED_REPOS` | `repo-not-allowed` |
| Run-history store configured | `DF_RUN_HISTORY_DRIVER` / `…_DATABASE_URL` | `run-history-not-configured` |
| Control store configured | `DF_CONTROL_DRIVER` / `…_DATABASE_URL` | `control-store-not-configured` |
| Store reached | (TCP probe) | `store-unreachable` |
| Store is local, unless opted in | (host of the URL) | `remote-store-refused` |
| Sandbox seam up (when `DF_SANDBOX_DRIVER=opensandbox`) | `DF_SANDBOX_ENDPOINT` / `DF_SANDBOX_IMAGE` | `sandbox-not-configured` / `sandbox-unreachable` |
| No other run holds the issue's claim | (run-history) | `claim-held` *(R2 names the fix)* |

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

## Failure shapes

- **Parked at the end?** Expected — the plan is on the issue awaiting approval (ADR 0041). Re-run after approving
  or retiring.
- **Refused with `remote-store-refused`?** Point at the local Postgres, or pass `--allow-remote-store`.
- **Refused with `claim-held`?** A previous run holds the issue; retire it (#404 R2) or wait for it to finish.
