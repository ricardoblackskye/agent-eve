# Sandbox push TLS trust + terminal lifecycle on abort — Implementation Plan

**Goal:** make the vault-path push succeed with certificate verification left ON, and make any
failure after a run is accepted end that run terminally, so it can never hold its claim.

**Issue:** #376 — found by the first end-to-end Dark Factory run against the local Kubernetes
sandbox (WebFeedPOC #165).

**Branch:** `fix/df-sandbox-push-tls-376` (off `origin/main` @ `545d177`).

**Architecture:** two independent defects, both on the sandbox path only.

1. The egress sidecar terminates outbound TLS with a root it mints, because that is how it injects
   the vaulted `Authorization` header. Nothing hands that root to git, so the first real in-sandbox
   push dies at certificate verification.
2. The runner's coding-phase `try/catch` applies the terminal lifecycle only for a
   `CircuitTrippedError`. Every other failure escapes to the top-level `main().catch`, which logs and
   sets an exit code. The run is therefore left non-terminal: ticket on `df:running`, ledger holding
   a claim no later attempt may adopt.

**Tech Stack:** TypeScript, vitest, OpenSandbox control plane on minikube.

## Root cause (verified by observation, not inference)

Measured inside a vault-enabled sandbox created with the real image
(`credential_proxy=CredentialProxyConfig(enabled=True)`, egress allowing `github.com`):

| Observation                  | Value                                                                                  |
|------------------------------|----------------------------------------------------------------------------------------|
| Process identity             | `uid=1000(node)`, `sudo: MISSING`                                                      |
| System trust store           | `/usr/local/share/ca-certificates/` is EMPTY                                           |
| Certificates in git's bundle | 150 (`/etc/ssl/certs/ca-certificates.crt`)                                             |
| Sidecar root                 | `CN = mitmproxy, O = mitmproxy`                                                        |
| Merged bundle                | `/opt/opensandbox/merged-ca-certificates.pem`, 151 certs (full root set + the mitm CA) |
| `OPENSANDBOX_MERGED_CA`      | unset in an `exec` session (exported only into the bootstrap's own services)           |

`execd` installs that root via `_sudo`, whose fallback branch runs the command anyway when the
process is neither root nor has `sudo`, so the install fails with a warning no caller surfaces.

Git behaviour, same sandbox:

```text
A bare                            exit=128  server certificate verification failed
B git -c http.sslCAInfo=<bundle>   exit=0
C git -c http.sslCAInfo=<mitm CA>   exit=0
D real target repo, merged bundle exit=0    (HEAD 15f22ed, refs/heads/feat/dark-factory-163)
```

For the lifecycle defect, the runner's own log shows the sequence: `-> Cleared: df:done, df:failed`
and then **no** `df:failed`, with the ledger's newest row left `status=queued stage=trigger`.

## Intended fix

**Fix A — hand the in-sandbox git the sidecar's CA.** In the vault path's `runGit`
(`agent/lib/dark-factory/opensandbox-driver.ts`), pass the CA to git as a per-invocation override, guarded so it is
applied only where the MITM actually created the bundle:

```text
# Applied ONLY where the MITM created the bundle; no exported variable, so nothing else
# in the sandbox inherits a trust override.
GIT_CA=""
[ -f /opt/opensandbox/merged-ca-certificates.pem ] &&
  GIT_CA="-c http.sslCAInfo=/opt/opensandbox/merged-ca-certificates.pem"
GIT_TERMINAL_PROMPT=0 git $GIT_CA <command>
```

**Fix B — end the run terminally on ANY post-acceptance failure.** Extract the coding-phase catch
body into an exported helper and make the terminal lifecycle unconditional; keep the trip-specific
recording for `CircuitTrippedError`:

```text
recordBreakerTrip(...)   # only when error instanceof CircuitTrippedError
applyTerminalLifecycle({ labelWriter, runHistory },
                       { repo, issue, runId, terminalStatus: "failed" })
```

### Rejected alternatives

| Option                                          | Why not                                                                                                                                                                          |
|-------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `GIT_SSL_NO_VERIFY=1`                           | Turns verification off against the very proxy holding the push token. The MITM is intentional; disabling trust for it is not the same as trusting its CA.                        |
| An image-level default CA path                  | Breaks git on any sandbox without the MITM: git fails with `Problem with the SSL CA cert (path? access rights?)`. The vault path is the only place the file exists.              |
| Adding `sudo` (or running as root) in the image | `sudo -n` needs a password-free sudo rule plus root, and the image deliberately runs unprivileged (`USER node`). Changes a documented posture to work around a missing variable. |
| A `DF_SANDBOX_GIT_CA_PATH` env var              | YAGNI: the path is fixed by `execd`. An env var would add a `.env.example` entry and an `env-example-coverage` surface for no gain.                                              |

## ADRs to add (decided here, written in the same change)

| ADR  | Title                                                                                       | Why a future developer asks "why?"                                                                                         |
|------|---------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| 0039 | The in-sandbox push trusts the egress sidecar's CA and never disables verification          | It looks like a weakening of TLS; the reasoning (deliberate MITM, token containment) is not visible in the code            |
| 0040 | Any post-acceptance failure ends the run terminally, so a claim is never held by a dead run | Otherwise "why does a push failure label the ticket failed?" reads as incidental, and the claim semantics are rediscovered |

Both need an index row in `docs/adr/README.md` (`tests/adr-integrity.test.ts` fails on an orphan).

## Tasks

### Task 1 (RED) — pin the CA hand-off on the vault path

**Files:** `tests/dark-factory/opensandbox-driver.test.ts`

1. Add a case asserting the command the driver hands to the sandbox carries the guarded CA
   override and still ends with `GIT_TERMINAL_PROMPT=0 git …`.
2. Update the two existing exact-match assertions that pin the un-prefixed command
   (`open sandbox-driver.test.ts` lines ~205-250). Tighten them to intent — assert the git portion —
   rather than weakening them to a `toContain` on a substring that any prefix would satisfy.
3. Run `npx vitest run tests/dark-factory/opensandbox-driver.test.ts`.
   Expected: FAIL — the command is currently `GIT_TERMINAL_PROMPT=0 git …` with no CA override.
4. Commit: `test(376): RED — the in-sandbox git is handed the egress CA`.

### Task 2 (GREEN) — apply the CA in the driver

**Files:** `agent/lib/dark-factory/opensandbox-driver.ts`

1. Add the guarded CA override inside the `runGit` capability (vault path only, which is where
   `runGit` exists at all).
2. Run the test file, then the full suite. Expected: PASS, no regressions.
3. Commit: `fix(376): GREEN — hand the in-sandbox git the egress sidecar CA`.

### Task 3 (RED) — pin the terminal lifecycle on a non-trip failure

**Files:** `tests/dark-factory/runner-sandbox-lifecycle.test.ts` (extend)

1. `runCodingPhase` is already exported and unit-tested, but the lifecycle is applied in `main`'s
   catch, which is not reachable from a test. Per the repo's rule that a RED may add the minimal
   signature a test needs, extract the catch body into an exported
   `finalizeCodingPhaseFailure(...)` **behaviour-unchanged** (still trip-only), then assert in the
   test that a plain `Error` also produces `terminalStatus: "failed"` with the run's repo/issue/runId.
2. Run `npx vitest run tests/dark-factory/runner-sandbox-lifecycle.test.ts`.
   Expected: FAIL — a non-trip error currently applies nothing.
3. Commit: `test(376): RED — a failed sandbox phase must end the run terminally`.

### Task 4 (GREEN) — make the lifecycle unconditional

**Files:** `scripts/dark-factory-runner.ts`, `agent/lib/dark-factory/run-finalizer.ts` if the helper
belongs there

1. Make the extracted helper apply `applyTerminalLifecycle(..., "failed")` for every error; keep the
   trip recording gated on `CircuitTrippedError`.
2. Keep `sandbox-runner-wiring.test.ts` green: `createSandboxProvider(` must still appear exactly
   once and inline as `runCodingPhase(`'s first argument — this change must not touch that call site.
3. Run the full suite. Expected: PASS.
4. Commit: `fix(376): GREEN — any post-acceptance failure ends the run terminally`.

### Task 5 — ADRs and documentation

**Files:** `docs/adr/0039-df-sandbox-push-trusts-egress-ca.md`,
`docs/adr/0040-df-run-failure-is-terminal.md`, `docs/adr/README.md`

1. Write both ADRs (Context / Decision / Consequences, status `Accepted`) and add the index rows.
2. Run `npx vitest run tests/adr-integrity.test.ts`. Expected: PASS.
3. Commit: `docs(376): GREEN — ADRs 0039 and 0040`.

### Task 6 — correct the stale claims on #354 and #358

Not code. Both closed issues assert that a bare-URL in-sandbox `git push` succeeded. Given Task 1's
evidence that cannot have been observed through the current mechanism (no CA hand-off, and the
harness proof targets `httpbin` with `--no-check-certificate` and never runs git). Post a correction
on each pointing at #376, and attach the first real push log once #165 is re-run.

## Files likely to change

| File                                                             | Change                                                   |
|------------------------------------------------------------------|----------------------------------------------------------|
| `agent/lib/dark-factory/opensandbox-driver.ts`                   | guarded CA override in `runGit`                          |
| `scripts/dark-factory-runner.ts`                                 | extract the catch body; unconditional terminal lifecycle |
| `tests/dark-factory/opensandbox-driver.test.ts`                  | RED for the CA; tighten the exact-match assertions       |
| `tests/dark-factory/runner-sandbox-lifecycle.test.ts`            | RED for the lifecycle                                    |
| `docs/adr/0039-*.md`, `docs/adr/0040-*.md`, `docs/adr/README.md` | the two decisions                                        |

## Validation

Local gate, in order (all before any push):

```text
npx tsc --noEmit --incremental false
npx vitest run
npx -y cspell@8 --config .cspell.json <changed files>
npx -y markdownlint-cli@0.45.0 -c <mdl-config.json> <changed .md>
npx -y markdown-table-formatter@1.6.1 --check <changed .md>
```

Then the real proof: re-run WebFeedPOC #165 on the minikube sandbox and read the PR diff — the push
must land and the run must end on `df:done` with a terminal ledger row, or fail on `df:failed` with
a terminal row. Unit tests prove the hand-off and the lifecycle; only that run proves the push.

## Risks / open questions

- **The existing exact-command assertions will fail on GREEN.** That is expected and is a tightening,
  not a weakening — record what each assertion means (the git portion) rather than dropping it.
- **The `[ -f ]` guard is load-bearing.** Without it, git on a non-MITM sandbox fails with
  `Problem with the SSL CA cert (path? access rights?)`, which would break the non-vault path. The
  RED must cover both branches (present and absent) or the guard is untested.
- **`finalizeCodingPhaseFailure` extraction touches a 1200-line script.** Any edit risks the two
  source-text guards (`sandbox-runner-wiring.test.ts`, and the `createSandboxProvider` inline
  requirement). Prefer an extraction that adds a function without moving the call site.
- **Claim reaping stays out of scope.** This change stops a *new* failure holding a claim; the
  already-held row in the test ledger, and the general lease policy, remain #375.
- **Not proven until the re-run.** The fix is proven at unit level plus the manual sandbox
  experiment in this plan. Treat "the push works" as unproven until #165 produces the log.
