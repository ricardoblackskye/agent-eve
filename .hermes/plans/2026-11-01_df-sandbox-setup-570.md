# #570 — one local sandbox setup, tested and re-runnable

## Goal

A local sandbox setup that a fresh machine can run **twice** and get the same working result both
times, where "working" means a sandbox that can actually serve the credential vault - proven by a
real substitution, not by a health check.

## Verified state (read from the files, tonight)

- `scripts/sandbox-server-up.sh` (66 lines, `npm run df:sandbox-up`) starts `uvx opensandbox-server`
  - the **Docker/uv runtime** - as a host process, health on **:8080**; `EXAMPLE` defaults to
  `docker`. Zero operational `minikube`/`kubectl`/`helm` invocations. The Docker runtime hard-rejects
  `secure_access` and never serves `/credential-vault`, so it cannot do what the Dark Factory's
  credential path needs.
- `docs/pages/dark-factory-local-runs.md` says to run `df:sandbox-up` and then set
  `DF_SANDBOX_ENDPOINT="http://127.0.0.1:18082"` - a **cluster port-forward** port. The script it names
  serves `:8080`. The document names one runtime and configures another.
- `scripts/k8s-vault-proof/bootstrap.sh` **already exists and is the proven path**: "Re-runnable
  bootstrap for a LOCAL OpenSandbox control plane that serves the Credential Vault", verified against
  minikube v1.39.0 / K8s v1.34.0 / OpenSandbox 1.1.1 with live MITM injection, and it documents the
  port-forward on **18082** followed by `vault-proof.py --port 18082`.
- Its **step 8 is the idempotence bug**: `kubectl create ConfigMap opensandbox-server-config
  --dry-run=client -o yaml | kubectl apply -f -` runs *after* Helm created that ConfigMap, so it ends
  up owned by both `helm` and `kubectl-client-side-apply` and the next `helm upgrade` aborts with
  `Apply failed with 1 conflict: ... .data.config.toml`, leaving `helm list` at STATUS `failed` while
  every pod is `1/1 Running`.
- `scripts/sandbox-smoke.ts` defaults to `DF_SANDBOX_ENDPOINT ?? "127.0.0.1:8080"` and
  `DF_SANDBOX_IMAGE ?? "python:3.12"`, creates a sandbox with a raised timeout, and exits 1 on
  failure - but it does **not touch the vault**. Reachability only.
- `scripts/sandbox-image/` holds the image build (`Dockerfile`, `verify-image.ts`) and its README uses
  `minikube image load df-sandbox-agent-eve:358`, while the local-runs doc uses
  `df-sandbox-webfeedpoc:4` - two image conventions.
- Leftover sandboxes exhaust the single minikube node (`FailedScheduling: Insufficient memory`), so a
  second run can fail for state rather than for code.

## Design

One runtime, one endpoint, one proof.

1. **`df:sandbox-up` brings up the runtime that can serve the vault** - the K8s control plane from the
   existing proven bundle - rather than the Docker/uv server. The Docker path either goes, or stays
   explicitly documented as non-vault-only (AC7).
2. **Idempotence**: Helm must be the **single owner** of the ConfigMap it creates. Fold the proven
   config (workload provider, egress `dns+nft`, ingress gateway, secure_access key,
   `sandbox_create_timeout_seconds`) into the Helm install/upgrade values rather than patching it
   afterwards with `kubectl apply`. Second run = no conflict, no manual repair.
3. **The smoke must be able to fail on the vault**: reuse `vault-proof.py`'s substitution probe as the
   assertion of record. A reachable-but-incapable server must not pass.
4. **Cleanup**: delete leftover `batchsandboxes` so the next run schedules.
5. **The docs name one runtime and one endpoint**, derived from the same source.

## Tasks

1. Branch + this plan + GATE 1.
2. Make the ConfigMap Helm-owned; prove a second full run with no conflict (RED first: run the current
   script twice and capture the `Apply failed with 1 conflict` failure as the failing test).
3. Point `df:sandbox-up` at the K8s bootstrap; keep `df:sandbox-smoke` but make its success criterion
   the vault substitution (RED first: the current smoke passes against a server that cannot serve the
   vault).
4. Cleanup of leftover sandboxes, with a control.
5. Docs: one runtime, one endpoint, and what the Docker runtime cannot do.
6. Full gates, then PR.

## Acceptance criteria mapping

| Issue AC | How it lands here |
| --- | --- |
| AC1 vault served, proven by substitution | Task 3 - the vault probe becomes the smoke's assertion |
| AC2 second run with no manual repair | Task 2 - Helm single ownership, proven by running twice |
| AC3 leftovers cleaned | Task 4 |
| AC4 one runtime, one endpoint, agreeing | Task 5 |
| AC5 smoke can fail on the vault | Task 3 |
| AC6 cluster absent fails loudly | Up-front prerequisite assertion naming the missing cluster |
| AC7 Docker runtime not silently "the sandbox" | Task 5, explicitly documented |

## Risks and deviations to flag

- **Reusing the proven bundle is the point.** `bootstrap.sh` exists and is verified; this should shape
  it into the supported entry point rather than re-derive the setup. Any rewrite of its verified
  settings is a deviation worth reviewing.
- **Host-only traps stay real**: git identity baked into the image, `core.autocrlf`, no network at test
  time, `minikube image load` (the docker store is invisible to containerd). The setup must not "fix"
  these silently by weakening the sandbox's deny-by-default egress.
- **#383 depends on this** (#570 first, then invert the default), so the setup's failure modes become
  the default experience: they need to be loud, not silent.

## Out of scope

- Inverting the default run posture (#383 AC1).
- The production/CI sandbox deployment.
