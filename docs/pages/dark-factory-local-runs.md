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

The sandbox seam (#553) lives in [`scripts/sandbox-up.ts`](../../scripts/sandbox-up.ts) — the CLI that
wires the core to real processes — and [`agent/lib/dark-factory/sandbox-provisioning.ts`](../../agent/lib/dark-factory/sandbox-provisioning.ts)
— the provisioning core itself. Progress events (#585 T2) are defined in
[`agent/lib/dark-factory/sandbox-events.ts`](../../agent/lib/dark-factory/sandbox-events.ts): one JSON
object per line on stdout, with human prose on stderr. The exit-code table (#585 T3) lives in
[`agent/lib/dark-factory/sandbox-exit-codes.ts`](../../agent/lib/dark-factory/sandbox-exit-codes.ts).
Idempotent resume (#585 T4) is owned by [`agent/lib/dark-factory/sandbox-state.ts`](../../agent/lib/dark-factory/sandbox-state.ts): it records each completed stage and the inputs that produced it in `.data/sandbox-provision-state.json`, so a second run skips a stage only while its inputs still match and a changed digest invalidates that stage and everything downstream of it.
A read-only preflight (#585 T5) lives in [`agent/lib/dark-factory/sandbox-check.ts`](../../agent/lib/dark-factory/sandbox-check.ts): `--check` probes the required binaries, the artifact lock, the image cache and the local image store without starting a cluster, pulling an image or writing state, so `npm run df:sandbox-up -- --check` answers whether a run could work and exits 10 when a prerequisite is missing.
Binary acquisition ownership (#603) is owned by [`agent/lib/dark-factory/sandbox-manifest.ts`](../../agent/lib/dark-factory/sandbox-manifest.ts): the manifest schema (the `binaries` array in [`scripts/sandbox-vendor/artifacts.lock.json`](../../scripts/sandbox-vendor/artifacts.lock.json)) records each required binary's minimum version and its probe command, and both `--check` and a real run verify every installed binary against it — refusing with exit 10 when a binary is missing and exit 15 when an installed version mismatches the manifest, before any stage mutates the machine.
Flag parsing and secret refusal (#585 T6) live in [`agent/lib/dark-factory/sandbox-flags.ts`](../../agent/lib/dark-factory/sandbox-flags.ts): one parser owns the flags, unknown flags exit 2, and `--token` (with `--password`, `--api-key` and `--secret`) is refused outright because a secret on argv is visible in the process table and in shell history - pass it on stdin or use a vault handle instead.
The chart, CRDs and digest lock are vendored under
[`scripts/sandbox-vendor/`](../../scripts/sandbox-vendor/).

## For the Windows program (#582)

The Windows installer lives in a separate repository (per the #584 boundary): it owns prerequisite
detection, binary acquisition, orchestration UX, state and retry, and the GUI. It drives this CLI -
it does not re-implement provisioning. The CLI is the contract between the two repos.

- **Version check first.** Before launching a provision, the program calls
  `npm run df:sandbox-up -- --version` and reads the semver from stdout. It must refuse a checkout
  whose CLI version it does not support (the #584 version-coupling rule); this CLI does not enforce
  a minimum program version itself. The version is exposed by
  [`agent/lib/dark-factory/sandbox-version.ts`](../../agent/lib/dark-factory/sandbox-version.ts).
- **Invoke headless.** Every run is flags-only, e.g. `npm run df:sandbox-up -- --check` for the
  preflight and `npm run df:sandbox-up -- [flags]` for the real provision. No prompts are emitted.
- **Read stdout as NDJSON, stderr as prose.** Each line on stdout is one JSON event (the schema is
  pinned by the gui-contract suite); human prose goes to stderr. Render the step list from the
  events and never parse the prose.
- **Branch on the exit code and problem `code`.** The exit-code table above maps each failure class
  to a distinct code; when a check or provision fails, the terminal `done` event also carries
  `exitCode`, and each `problems[]` entry carries a `code` (e.g. `prerequisites-missing`,
  `prerequisites-mismatch`) the program can switch on.
- **Never pass a secret on argv.** `--token` / `--password` / `--api-key` / `--secret` are refused
  (exit 2). Supply the vault secret on stdin or via a vault handle.

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
npm run df:sandbox-vendor      # populate the image cache from the committed digest lock
npm run df:sandbox-up          # deploy + port-forward + vault proof, in one command


export DF_SANDBOX_DRIVER=opensandbox
export DF_SANDBOX_ENDPOINT="http://127.0.0.1:18082"
export DF_SANDBOX_PROTOCOL=http
export DF_SANDBOX_IMAGE="df-sandbox-webfeedpoc:4"
```

### The sandbox lifecycle commands (#553)

| Command | What it does | Exit |
|---------|--------------|------|
| `npm run df:sandbox-vendor` | Populate the gitignored image cache from `artifacts.lock.json`, verifying each digest. Refuses if the registry serves different bits. | `0` cached, `1` refused |
| `npm run df:sandbox-up` | Provision **and** prove: `helm dependency build`, deploy, wait for rollout, port-forward, run the vault proof, tear the forward down. | `0` proven, otherwise the table below |
| `npm run df:sandbox-up-shell` | The raw `bootstrap.sh`, kept as an escape hatch for debugging the executor. | `0`/`1` |
| `npm run df:sandbox-down` | Surgical teardown: uninstall the release, delete both namespaces, stop the forward. **Leaves minikube running** so a re-run is warm. | `0` torn down |
| `npm run df:sandbox-down -- --delete-cluster` | The full reset: the above, then `minikube delete`. | `0` |
| `npm run df:sandbox-smoke` | The vault substitution proof alone, against an endpoint that is already up. | `0` proven |
| `npm run df:sandbox-forward` | Manual port-forward, for when you want to poke the API by hand. | — |

`df:sandbox-up` **is the proof**. It does not print "now run the proof in another terminal" — it runs
`vault-proof.py` itself and exits non-zero unless a placeholder became the real secret upstream. A shell
script that hands the proof back to you as a follow-up step is not the supported path; use
`df:sandbox-up-shell` only when you are debugging the executor.

### Exit codes (#585 T3)

Every failure used to exit `1`, so on Windows a helm cache failure and a vault failure looked
identical. The table is stable and lives in
[`sandbox-exit-codes.ts`](../../agent/lib/dark-factory/sandbox-exit-codes.ts); a caller branches on the
number instead of parsing English. The terminal `done` event carries the same code, so a GUI consumer
reads it without inspecting the process exit.

| Problem code | Exit | Meaning |
|--------------|------|---------|
| `internal` | `1` | Unclassified internal failure. Also the crash path when `main()` throws. |
| `prerequisites-missing` | `10` | A prerequisite is missing or unusable (docker, kubectl, helm, python, minikube for a local cluster). The message names the binary and the fix. |
| `prerequisites-mismatch` | `15` | A prerequisite is present but its version or digest does not match the manifest (`scripts/sandbox-vendor/artifacts.lock.json`). The message shows the expected vs actual version. Owned by #603. |
| `artifact-unresolvable` | `11` | An artifact is unresolvable: the lock is absent or malformed, the cache is empty, or a locked image is not in the local store. |
| `cluster-unreachable` | `12` | The cluster is unreachable: `minikube start` failed or the kube context does not answer. |
| `proof-failed` | `13` | The proof failed: the endpoint could not be reached, or the vault proof did not substitute the placeholder. |
| `teardown-failed` | `14` | Teardown failed: the port-forward or the release cleanup did not complete. |

Two codes sit outside this table. `0` means provisioned and proven. `2` means a usage error: an
unknown flag or a refused secret. Both are raised outside the provisioning core — `0` on success and
`2` by flag parsing before provisioning starts — so neither is a `ProvisionProblemCode`.

`--check` uses the same numbers without mutating anything: `10` for a missing prerequisite and `11`
for an artifact problem. A preflight refusal is never `0`, so a script that runs `--check` first can
gate on it directly.

### The NDJSON event stream (#585 T2)

Progress is one JSON object per line on **stdout**, and nothing else. Human prose goes to **stderr**,
so a consumer can read events line-wise without stripping text and an operator still gets readable
errors. The schema is defined in
[`sandbox-events.ts`](../../agent/lib/dark-factory/sandbox-events.ts).

| Field | Type | Notes |
|-------|------|-------|
| `ts` | string | ISO-8601 UTC. Lets a consumer render ordering without guessing. |
| `step` | string | One of `check`, `vendor`, `cluster`, `deploy`, `forward`, `proof`, `teardown`, `done`. |
| `phase` | string | One of `start`, `success`, `failure`, `skip`. |
| `message` | string | Short and human-readable. Structured detail goes in optional extra keys. |
| `exitCode` | number | Present on the terminal `done` event only. |

The terminal event is always `step: "done"` and carries the exit code, so a consumer stops on one
line instead of inferring completion from silence. A `phase: "skip"` event means the stage was
resumed from the state file and its commands were not re-run. A consumer should treat a skipped
stage as already satisfied, not as a missing one.

### The state file (#585 T4)

A second run against an unchanged workspace does not redo the work. Completed stages and the inputs
that produced them are recorded in `.data/sandbox-provision-state.json`; a stage is skipped only
while its recorded inputs still match the current ones. A changed artifact digest or cluster context
invalidates that stage and everything downstream of it, so a re-run never reports "skipped" for bits
that no longer match reality. The file carries no secrets: digests, paths and the cluster context
only. The logic lives in
[`sandbox-state.ts`](../../agent/lib/dark-factory/sandbox-state.ts).

### Flags (#585 T6)

Flags configure the single entry point; the environment stays as a fallback so existing invocations
keep working. `--check` runs the preflight and stops. `--forward-port` sets the local port (default
`18082`). `--cluster minikube` starts or reuses a local cluster. `--kube-context` targets an existing
cluster by context and takes precedence over `--cluster`; `--kubeconfig` supplies its kubeconfig.
`--artifacts-dir` and `--workspace-dir` override the default locations. `--help` prints the usage
text to stderr and exits `0`, keeping stdout NDJSON-only.

Secrets are **refused on argv**, not redacted: `--token`, `--password`, `--api-key` and `--secret`
exit `2` with a message pointing at stdin or a vault handle. A token on the command line is visible
in the process table and lands in shell history and CI logs, so accepting one and cleaning it up
later would already be too late. The parser lives in
[`sandbox-flags.ts`](../../agent/lib/dark-factory/sandbox-flags.ts).

> Note: when invoked through `npm run` or `npx`, the wrapper echoes the full command line to stderr
> before this parser runs. The application never prints the value, but the wrapper's echo means a
> secret passed on argv still reaches CI logs. The refusal stops the run; rotate the secret if one
> was passed.

### Pointing at an existing cluster instead of minikube (#553 AC4)

```bash
KUBE_CONTEXT=prod-east npm run df:sandbox-up
```

`KUBE_CONTEXT` selects an existing kube context and **skips `minikube start`**. `KUBE_KUBECONFIG` supplies a
non-default kubeconfig. `HELM`, `KUBECTL`, `MINIKUBE` and `DOCKER` override binary discovery when those tools
are installed somewhere PATH does not reach — this repository's own Windows setup keeps helm in a temp
directory, so the override is the normal case rather than an edge case.

`FORWARD_PORT` changes the local port (default `18082`); `DF_SANDBOX_ENDPOINT` must name the same port.

### Tearing down (#553 AC5)

```bash
npm run df:sandbox-down                     # release the sandbox, keep the cluster
npm run df:sandbox-down -- --delete-cluster # full reset, ~12 minutes to cold-start again
```

Teardown is **surgical by default**. It uninstalls the Helm release, removes the control-plane and workload
namespaces, and stops the port-forward — then leaves minikube running so the next `df:sandbox-up` is a warm
`helm upgrade --install` rather than a cold four-CPU start. It fails if the port is still listening after
teardown, because a forward that outlived its run is what makes the next run die with "address already in use"
and no clue why.

### What does not survive a disconnect (#383 AC4)

The sandbox is **disposed in the run's `finally`** when the coding phase ends — on success, on
throw, and on failure. It is not a persistent session.

Consequences for an operator:

- A **network or terminal disconnect does not park the run.** The sandbox is torn down by the
  runner's cleanup path, and a disconnected run is not resumable.
- A sandbox that **dies mid-run** fails the run loudly; it is not re-provisioned or resumed.
  Recovery from a parked or failed run is tracked in #380.
- "Sessions survive disconnect" in the Pillar 5 whitepaper is **not met by the current local
  run path.** What *is* met is the lifecycle guarantee: a run cannot leave a sandbox running,
  however it exits.

If you need a session to outlive a disconnect, keep the sandbox and its port-forward alive
yourself and run commands against the existing endpoint.

### Cold start for the pre-built image (#383 AC3)

**Cold start = time from `SandboxSync.create()` until the sandbox reports ready.** A second metric,
first-command latency, captures time until the sandbox is actually usable. Measured against the live local
cluster (minikube, `opensandbox-server` on port-forward 18082) with image `df-sandbox-agent-eve:358`
(3.12 GB, pre-built and pre-loaded):

| Run | create-to-ready | first-command | Notes |
| --- | --- | --- | --- |
| 1 | 3.02s | 0.33s | health check skipped |
| 2 | 2.63s | 0.28s | health check skipped |
| 3 | 2.41s | 0.28s | health check enabled (default) |

**Median ≈ 2.63s, range 2.41–3.02s.** Enabling the health check added no measurable time.

The Pillar 5 bar is **cold start under 10 minutes**. A per-sandbox start is roughly 200× under it. Even
counting the first-ever `minikube image load` (4m32s once), total first-run cold start is ≈ 4m35s — still
under the bar. That image load is a **one-time** provisioning cost, not a per-run cost.

**Conditions this figure holds under:** a warm cluster with the image already in containerd, so pod
scheduling and container start only — no registry pull. A cold *cluster* adds the image load; both figures
are stated so neither is hidden. The measurement is reproducible via the timing script tracked in #589.

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

## Applying database migrations

`db/migrations/*.sql` enable RLS and set the view's `security_invoker` option. They are **not** applied
automatically. Run them deliberately:

```bash
npm run db:migrate -- --status   # read-only: prints applied and pending, changes nothing
npm run db:migrate -- --apply    # applies pending files in filename order
```

**DSN resolution order** (first one set wins):

1. `--database-url <url>`
2. `DF_MIGRATE_DATABASE_URL`
3. `DF_RUN_HISTORY_DATABASE_URL`

**Exit codes:** `0` applied or nothing pending; `1` drift or a failed migration (and `--status` when work is
pending); `2` usage error — no action, no DSN, or an unknown flag.

**Drift is a refusal.** If an applied file's checksum changed, or the database records a version with no file
in the checkout, the runner stops and names what disagrees. Do not edit an applied migration; add a new one.
The checksum is CRLF-normalised, so a Windows checkout and a Linux deploy agree on the same file.

**Baseline caveat — read this before applying to a truly empty database.** The migrations are differential:
they `ALTER` tables the application creates at runtime (`ensureSchema`). On a completely empty database the
first migration that alters a runtime-created table fails with `relation ... does not exist`. The ordered
bootstrap is therefore **two steps**: start the application once so its runtime DDL creates the base tables,
then `npm run db:migrate -- --apply`. A one-command bootstrap is not built yet; that gap is tracked in #594.

**Before the first production run**, take a snapshot and run `--status` first — it changes nothing. Every
migration is idempotent, but "should be safe" is not "is safe".

Verification after applying `011`:

```sql
-- Tables in public still without RLS (should be empty)
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
  AND c.relname LIKE 'df\_%' ESCAPE '\';

-- Views in public without security_invoker (should be empty)
SELECT c.relname, c.reloptions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v'
  AND (c.reloptions IS NULL OR NOT ('security_invoker=true' = ANY(c.reloptions)));
```

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

## When the sandbox setup goes wrong

Every entry below cost real time to diagnose, and each was invisible until something was run
from nothing rather than against an already-prepared cluster. Symptom first, because that is
what you will actually see.

### `minikube start` fails with a docker-pipe error

```text
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
```text

**Cause:** Docker Desktop's engine is not running.
**Fix:** start Docker Desktop. The message names a Docker-internal pipe rather than the
missing prerequisite, which is why this is easy to misread as a minikube problem: check
`docker ps` first. If the `docker` CLI works but minikube cannot see the engine, the engine
has stopped since the CLI last succeeded.

### `helm` or `kubectl` cannot find a path that plainly exists

```text
Error: failed parsing --set-file data: open /c/Users/.../config.toml:
  The system cannot find the path specified
error: the path "/c/Users/.../sandbox.opensandbox.io_pools.yaml" does not exist
```text

**Cause:** `helm` and `kubectl` are native Windows binaries and do **not** translate MSYS
paths. `cd` and heredoc redirection work because bash handles those; a path handed to a native tool as a
*file argument* does not.
**Fix:** convert once with `cygpath -m` and use that form for every native consumer. The
script does this with `REPO_NATIVE`. A guard asserts it, because the `kubectl` case had been
failing silently: the chart-omitted CRDs were never applied on a fresh machine, and the
controller crashloops as a result.

### `helm upgrade` fails with `Apply failed with 1 conflict`

```text
Apply failed with 1 conflict: conflict with "kubectl-client-side-apply" using v1: .data.config.toml
```text

**Cause:** something other than Helm owns an object Helm created, so two field managers
disagree. Patching a chart-owned object with `kubectl apply` or `kubectl set env` is the usual
route in.
**Fix:** pass what you want through Helm **values** instead. A managedFields entry cannot be
edited away, so an already-broken cluster is repaired by deleting the object and letting Helm
recreate it - safe precisely because its content lives in the values.

### A release reads `failed` while the pods are still running

**Cause:** a failed upgrade leaves the release in `failed` and the control plane unready.
**Fix:** read `helm list -n opensandbox-system` rather than the pod list; a release that never
completed is not a working sandbox, however healthy the pods look in passing.

### `Create sandbox failed: Namespace not found: (404)`

**Cause:** the chart creates only the **control-plane** namespace. The sandbox **workload**
namespace is deliberately not its to create, and the server refuses to create a sandbox
without it.
**Fix:** the setup creates it. Note this only ever shows up on a cluster built from nothing -
on a long-lived cluster the namespace usually exists already, from a manual step nobody
recorded.

### The controller crashloops with "no matches for kind Pool/SandboxSnapshot"

**Cause:** the base chart ships only the `BatchSandbox` CRD. `Pool` and `SandboxSnapshot` are
missing, and the controller cannot start without them.
**Fix:** apply the two from `kubernetes/config/crd/bases/` - the setup does, as the one
remaining `kubectl apply`, because they are cluster-scoped and not Helm-owned.

### Sandboxes stay `Pending` with `Insufficient memory`

**Cause:** leftover sandboxes from earlier runs exhaust the single minikube node.
**Fix:** delete them between runs rather than resizing the node.

### The `[ingress]` config section is missing

**Cause:** `opensandbox-server.gateway.enabled` defaults to **false**, and the chart generates
the `[ingress]` block only when it is enabled. A hand-written block in the config file
compensates for the omission without solving it.
**Fix:** enable the gateway in values and let the chart generate the block, so the config is
stated in one place.

### Cold start takes about twelve minutes

Not a fault, but worth knowing before assuming something has hung: nearly all of it is image
pulls from the registry on a cold cluster. Measured from `minikube delete` to a working
control plane.

### The runtime that cannot serve the vault

The `uvx opensandbox-server` Docker runtime hard-rejects `secure_access` and never serves
`/credential-vault`. Anything needing credential injection - which includes the Dark Factory's
push path - requires the Kubernetes runtime above. A sandbox that starts and answers `/health`
is not evidence that it can do the job: the assertion that counts is a real
placeholder-to-secret substitution.

### `vendor.sh` refuses a digest that looks identical (#553)

```text
ERROR: digest mismatch for .../execd:release-1.1.1
  lock:   sha256:cda2bc35eded
  actual: sha256:cda2bc35eded
```

**Cause:** invisible whitespace. Two mechanisms produce it on Windows. First, python's text-mode
stdout turns every newline into a carriage-return plus newline, so the digest read from the lock
arrived with a trailing carriage return. Second, `core.autocrlf=true` checks
`artifacts.lock.json` out with CRLF in the first place. The comparison therefore failed while
both digests printed the same, because the difference was a character you cannot see.
**Fix:** the script emits through `sys.stdout.buffer` and strips the carriage return on both
sides, and `.gitattributes` pins LF for the lock file so the checkout cannot reintroduce it.
If you see this, run `npm run df:sandbox-vendor` again after
`git checkout -- scripts/sandbox-vendor/artifacts.lock.json`.

### `helm upgrade` fails with `Error: repo not found` (#553)

**Cause:** the umbrella chart declares its subcharts as `file://` dependencies. `helm upgrade` cannot
resolve those unless `helm dependency build` has populated `charts/` first. `bootstrap.sh` did this;
the TypeScript core path that replaced it did not.
**Fix:** the core runs `helm dependency build` before `upgrade --install`. If you see this from the
shell escape hatch, run `helm dependency build vendor/opensandbox-charts/opensandbox` first.

### A second `df:sandbox-up` fails with "address already in use" (#553)

**Cause:** a port-forward from a previous run outlived it. On Windows the teardown used
`process.kill(-pid)`, which targets a POSIX process *group* and throws — so the child survived and kept
port 18082. The next run's own forward then failed to bind, and the reachability probe hit the stale
listener, reporting "not reachable" for a cluster that was actually fine.
**Fix:** teardown uses `taskkill /PID <pid> /T /F` on Windows. If you hit this before the fix,
`netstat -ano | grep :18082` names the holder; `taskkill /PID <pid> /T /F` clears it.
