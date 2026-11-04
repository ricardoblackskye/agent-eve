# #585 — Headless CLI contract for sandbox provisioning

**Status:** plan for GATE 1 review. No code written yet.
**Parent:** #584 (Portfolio Epic: Windows setup program for Eve and the sandboxes).
**Related:** #553 (provisioning core, merged), #582 (GUI consumer), #344 (remote cluster, out of scope).

## Goal

Make sandbox provisioning callable as **one non-interactive command with a stable interface**, so the
Windows program (#582) renders events and maps exit codes instead of screen-scraping prose — and so CI
and developer setup use the same path.

The CLI is an **adapter over the existing provisioning core**, not a fourth orchestrator. `provisionSandbox`
in `agent/lib/dark-factory/sandbox-provisioning.ts` already owns artifact checks, cluster selection,
deploy, forward and proof. This work wraps it in a contract; it does not re-implement it.

## Verified current state (read from the tree, 2026-11-04)

| Piece | What it does today | Gap against the contract |
| --- | --- | --- |
| `scripts/sandbox-up.ts` | `main()` resolves artifacts dir + port + cluster, calls `provisionSandbox`, prints `ERROR: ...` to stderr and returns **1** on failure; prints one success line to stdout | No exit-code table, no NDJSON, no state file, no `--check`, no flag parsing |
| `scripts/k8s-vault-proof/bootstrap.sh` | Cluster + vault; reads `KUBE_CONTEXT`, `CHART_DIR`, `HELM`, `MINIKUBE`, `FORWARD_PORT` from env | Shell executor, not the caller contract; still the escape hatch |
| `scripts/sandbox-vendor/vendor.sh` | Populates the gitignored cache from `artifacts.lock.json` | Separate command; the contract should report its absence as a named failure, not run it implicitly |
| `agent/lib/dark-factory/sandbox-provisioning.ts` | Returns `{ ok, endpoint, problems: string[] }` | **Problems are free-text**, so a caller cannot map one to a distinct code without parsing |

The observed failure this closes: on Windows, `df:sandbox-up` failed with `helm dependency build failed`,
then required `HELM=C:/Users/.../helm.exe` exported by hand — and that failure was indistinguishable from
a vault failure because both exited 1.

## Design

### The command

```
eve-sandbox up [flags]        # or: npm run df:sandbox-up -- [flags]
eve-sandbox check [flags]     # --check equivalent
```

Flags only. Every value the GUI collects arrives as an argument; nothing prompts. Existing env vars keep
working as defaults so today's callers do not break.

### Exit-code table (AC2)

| Code | Meaning | Caller action |
| --- | --- | --- |
| `0` | Provisioned and proven | Proceed to run |
| `1` | Unclassified internal failure | Show the stderr text; report a bug |
| `2` | Usage error (unknown flag, missing required value, secret passed on argv) | Fix the invocation; do not retry |
| `10` | Prerequisites missing | Show the named prerequisite and how to install it |
| `11` | Chart or image unresolvable (cache empty, digest mismatch, chart missing) | Run the vendor step, then retry |
| `12` | Cluster unreachable | Check Docker/minikube or the supplied context |
| `13` | Vault proof failed | Inspect cluster logs; do not mark as installed |
| `14` | Teardown failed | Manual cleanup required; do not re-run blindly |

Codes are stable and documented in the command's `--help` and in the repo docs. `2` deliberately absorbs
AC6: a secret-looking flag is a usage error, not a special case.

### NDJSON on stdout (AC3)

One JSON object per line, stdout only. Human text goes to stderr. No ANSI on stdout.

```json
{"ts":"2026-11-04T14:00:00.000Z","step":"vendor","phase":"start","message":"checking artifact cache"}
{"ts":"2026-11-04T14:00:01.000Z","step":"vendor","phase":"success","message":"cache complete"}
{"ts":"2026-11-04T14:00:01.000Z","step":"cluster","phase":"skip","message":"minikube already running"}
{"ts":"2026-11-04T14:00:20.000Z","step":"proof","phase":"failure","message":"vault substitution not observed"}
```

- `step` ids follow the core's stages: `check`, `vendor`, `cluster`, `deploy`, `forward`, `proof`, `teardown`.
- `phase` ∈ `start | success | failure | skip`.
- `message` is short and human-readable; structured detail goes in optional extra keys.
- A terminal `{"step":"done","phase":"success|failure","exitCode":N}` line closes the stream.

### State file (AC4)

JSON at `.data/sandbox-provision-state.json` (`.data/` is already gitignored — #586). Records:
completed stages, artifact digests used, cluster/context, forward port, timestamps. **No secrets.**

Resume semantics: a re-run skips a completed stage **only if its inputs still match** (digest, context,
port); otherwise it redoes that stage and its dependants. Skips emit `phase:"skip"`, so the GUI can show
"already provisioned" rather than replaying. This is consistent with #553's decision that teardown leaves
minikube running.

### `--check` (AC5)

Returns structured results and **mutates nothing**. Exit `0` ready, `10` not ready. Checks: WSL2, Docker
daemon, virtualization, disk space, ports free, and binaries present. JSON on stdout; human text on stderr.

### Secrets (AC6)

No credential flags. Credentials arrive on stdin or by vault handle (`--vault-handle <name>`), matching the
#344/#581 redaction posture. A flag whose name looks secret-bearing (`--token`, `--password`, `--key`) is
refused with exit `2` rather than silently accepted.

### Binary acquisition — the open question

**Recommendation: the CLI resolves binaries from a documented location; the program supplies that location.**
No download in Phase 1.

- Resolution order: `PATH` first, then explicit env overrides (`HELM`, `KUBECTL`, `MINIKUBE`, `DOCKER`), then a
  `--bin-dir` the program passes. This preserves today's escape hatch and removes the observed failure by
  turning "helm not found" into exit `10` with the binary named and where to put it.
- Owning acquisition here would duplicate work the program must do anyway (it ships the binaries), and would
  reintroduce network-at-install-time — the non-reproducibility #553 removed.

**Flagged for GATE 1:** approve this, or require the CLI to own acquisition in Phase 1.

## Tasks (TDD; RED first per task)

### T1 — Failure classification in the core (prerequisite for AC2/AC3)
Upgrade `ProvisionResult.problems` from `string[]` to classified problems (`{ code: FailureCode, message, detail? }`)
while keeping a human-readable rendering. RED: a test asserts each failure class (missing cache, missing image,
cluster down, proof failed, teardown failed) yields a distinct code. GREEN: introduce the enum, map each `fail(...)`
call site. **Deviation to flag:** this changes an existing exported interface — call sites in tests and the GUI
contract must be updated in the same change.

### T2 — NDJSON event stream (AC3)
RED: a test drives a fake `exec` through a success path and asserts one line per stage transition, valid JSON per
line, and nothing on stdout that is not JSON. GREEN: an event emitter in the CLI adapter; stderr for prose.

### T3 — Exit-code mapping (AC2)
RED: table-driven test maps each `FailureCode` to its documented process exit code. GREEN: `main()` returns the
mapped code; a terminal `done` event carries it.

### T4 — State file and resume (AC4)
RED: run twice against a fake exec; second run emits `skip` for completed stages and does not re-run their commands.
A changed digest invalidates the relevant stage. GREEN: read/write `.data/sandbox-provision-state.json`; no secrets.

### T5 — `--check` mode (AC5)
RED: a missing prerequisite produces exit `10` and a structured result naming it; nothing is mutated (no docker/helm
calls beyond read-only probes). GREEN: implement the checks behind an injected `exec` so it stays testable.

### T6 — Flag parsing and secret refusal (AC1/AC6)
RED: unknown flag → exit `2`; `--token x` → exit `2` with a message pointing at stdin/vault handle; documented flags
map to the core's options. GREEN: a small parser with no dependency added.

### T7 — Windows CI (AC7)
RED: a workflow job that runs the new tests on `windows-latest` and fails if the job is absent. GREEN: add the job;
keep the existing Ubuntu typecheck/test jobs as controls. **Deviation to flag:** this adds CI minutes and a second OS
matrix for a subset of tests — confirm that is acceptable.

### T8 — Docs and `--help`
Document the flags, the exit-code table, the NDJSON schema, and the state-file location in the command help and in
`docs/pages/dark-factory-local-runs.md`. A doc-drift test asserts the help output and the doc table agree.

## Acceptance mapping

| AC | Lands in |
| --- | --- |
| AC1 — one entry point, flags only | T6 + T8 (replaces the bootstrap/sandbox-up split for callers; shell stays as escape hatch) |
| AC2 — exit-code table | T1 + T3 |
| AC3 — NDJSON on stdout | T2 |
| AC4 — idempotent state file | T4 |
| AC5 — `--check` | T5 |
| AC6 — no secrets on argv | T6 |
| AC7 — tests incl. Windows CI | T1–T6 + T7 |

## Risks and deviations to flag at GATE 1

1. **Changing `ProvisionResult.problems`** from `string[]` to classified errors touches an exported interface and its
   tests. Necessary for AC2 — a caller cannot map free text to codes without parsing — but it is the largest ripple.
2. **Windows CI** is new. The repo's CI is Ubuntu-only today; AC7 explicitly requires Windows.
3. **State-file resume** is only as good as its invalidation rules. If digests/context change without detection, a
   re-run reports "skipped" for stages that no longer match reality — worse than re-running. T4's tests must cover
   the invalidation paths, not only the happy skip.
4. **Behaviour change for existing callers:** `df:sandbox-up` currently prints one line; after T2/T3 it emits NDJSON.
   Anything parsing that line breaks. The shell escape hatch (`df:sandbox-up-shell`) remains the prose path.
5. **Binary acquisition** decision above. If the CLI owns it instead, T6 grows a download/verify path and the plan
   needs re-scoping.

## Out of scope

- Prerequisite detection moving out of this repo (Phase 2, #584 boundary table).
- The GUI itself (#582).
- Remote/cloud provisioning (#344).
- Manifest changes.
- Folding the cold-start measurement (#589) into the CLI — possible later, not here.
