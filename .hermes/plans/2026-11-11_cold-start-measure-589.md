# Plan: #589 — Track sandbox cold-start performance and commit the measurement script

**Issue:** ricardoblackskye/agent-eve#589 (label: chore)
**Branch:** `feat/589-cold-start-measure` (off `origin/main` @ 951a7b8)
**Approach:** commit the one-off timing script into the repo, mirror the
`vault-proof.py` connection pattern, record baseline + conditions in the
script docstring, and enforce a regression threshold at runtime.

## Why
#383 AC3 measured sandbox cold start against the live local cluster (median
≈2.63s, range 2.41–3.02s create-to-ready) but the measurement script was a
one-off in a temp directory — not in the repo. A performance claim that cannot
be re-run is a claim that drifts silently: a 3s cold start can become 60s via an
image / scheduling-policy / resource-request change and nobody notices. The
baseline IS already recorded in `docs/pages/dark-factory-local-runs.md`
(guarded by `tests/dark-factory/cold-start-docs.test.ts`, #597), but the
*script* that produces it was never committed.

## Current behaviour
- `scripts/k8s-vault-proof/` has `vault-proof.py`, `bootstrap.sh`, `README.md`
  but **no** cold-start measurement script.
- The cold-start figures live only in docs (and the closed #383/#597 threads).

## Target behaviour
- `scripts/k8s-vault-proof/measure-cold-start.py` exists and is runnable:
  `python scripts/k8s-vault-proof/measure-cold-start.py --port 18082`.
- It times `create-to-ready` (`SandboxSync.create()` → ready) and
  `first-command` (first `kubectl exec` after ready) against the live local
  cluster.
- Baseline (2.41–3.02s create-to-ready, 0.28–0.33s first-command) and the
  measurement conditions (warm cluster, image pre-loaded into containerd, no
  registry pull) are recorded in the script's docstring — next to the script.
- A regression threshold (15s create-to-ready ≈ 5× the median) is enforced:
  the script exits 2 when breached.
- `README.md` documents the command.

## Implementation
1. New file `scripts/k8s-vault-proof/measure-cold-start.py`:
   - Reuses `vault-proof.py`'s exact `ConnectionConfigSync(domain,
     protocol="http", api_key=None, use_server_proxy=True)` setup so it reaches
     the same port-forwarded local server.
   - `SandboxSync.create(image=..., entrypoint=["sleep","900"],
     skip_health_check=<flag>, ready_timeout=280s)`; time the call →
     `create_to_ready`.
   - Run `kubectl -n opensandbox exec <id>-0 -c sandbox -- sh -c "echo ready"`;
     time it → `first_command`.
   - `--threshold` (default 15.0s), `--image` (default alpine:3.19),
     `--skip-health-check` flags.
   - Exit 0 within threshold, 2 if `create_to_ready > threshold`, 1 on failure.
   - Docstring carries the baseline table + conditions + threshold rationale.
2. `scripts/k8s-vault-proof/README.md`: add the file to the Files table and a
   "Measure cold start" subsection with the run command.

## Out of scope / notes
- NOT a CI gate: cold start needs a live cluster, which CI lacks. Manual /
  periodic check until a cluster exists in CI (per the issue).
- The baseline is already in `dark-factory-local-runs.md`; left untouched so
  `cold-start-docs.test.ts` stays green. This plan records the *script*, which
  the docs reference via #589.

## Validation
- `python -m py_compile scripts/k8s-vault-proof/measure-cold-start.py` → passes
  (syntax). Done locally; the actual measurement needs a live minikube cluster +
  port-forward, which is intentionally not available here.
- `cold-start-docs.test.ts` unaffected (doc section unchanged).

## Acceptance-criteria mapping
- **AC1** script committed + documented command → README "Measure cold start".
- **AC2** baseline recorded next to script → script docstring (also already in
  docs).
- **AC3** regression threshold defined + enforced → 15s, exit 2.
- **AC4** conditions in docstring → warm cluster / image pre-loaded / no pull.
