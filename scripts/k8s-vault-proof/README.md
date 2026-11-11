# K8s Vault Proof

## Overview
Local Kubernetes dev harness and end-to-end verification scripts for OpenSandbox Credential Vault transparent secret injection and cold-start latency measurements.

## Interface
- `bootstrap.sh` - Bash deploy script provisioning local minikube, CRDs, and OpenSandbox umbrella chart without network fetches (flags/env: KUBE_CONTEXT, CHART_DIR, CACHE_DIR, MINIKUBE, HELM, NS_CP, NS_SB, FORWARD_PORT, KEYID)
- `vault-proof.py` - CLI end-to-end assertion testing transparent credential substitution (flags: --port)
- `vault-proof.py:redact(text: str, secret: str) -> str` - Secret masking helper preventing credential leaks to logs
- `measure-cold-start.py` - CLI measuring create-to-ready and first-command latencies against local cluster (flags: --port)

## Invariants
- [bootstrap.sh] Fetches nothing from the network at runtime; requires pre-cached artifacts in vendor/ and scripts/sandbox-vendor/cache
- [vault-proof.py] Sandbox created with credentialProxy.enabled=true never receives the real secret; egress sidecar MITMs outbound traffic and substitutes placeholder
- [vault-proof.py:redact] Never writes literal secret to stdout or log buffers
- [measure-cold-start.py] create-to-ready latency must remain below 15.0s (REGRESSION_THRESHOLD_S)

## Side Effects
- [bootstrap.sh] Starts and configures minikube cluster, installs CRDs, deploys Helm release, configures namespaces and egress MITM injection
- [vault-proof.py] Connects to OpenSandbox server, creates/deletes sandboxes, issues outbound HTTPS requests to httpbin.org
- [measure-cold-start.py] Creates and deletes test sandboxes in OpenSandbox cluster

## Verification
- Run: `npm test`

---

## Historical Notes

# Local-K8s Credential Vault proof harness

Dev tooling that reproduces a vault-capable OpenSandbox cluster and proves the property the
dark-factory depends on: a sandbox created with `credentialProxy.enabled` **never** sees the real
secret. The egress sidecar MITMs outbound HTTPS and substitutes a placeholder for the real value.

Verified against minikube v1.39.0 / Kubernetes v1.34.0 / OpenSandbox **1.1.1**.

## Why Kubernetes

The credential vault is Kubernetes-only. The Docker runtime hard-rejects it:

```text
HTTP 400 {"message": "secureAccess is not supported when runtime.type='docker'.
          Use the Kubernetes runtime to create secured sandboxes."}
```

so `uvx opensandbox-server` can never serve `/credential-vault`. Local Kubernetes does **not**
commit production to Kubernetes: the runtime is per-server and the application code stays
runtime-agnostic.

## Files

| File             | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `bootstrap.sh`   | Idempotent local deploy, including the non-obvious configuration fixes |
| `vault-proof.py` | End-to-end assertion; exits 0 when substitution is proven              |
| `measure-cold-start.py` | Cold-start latency measurement; exits 2 if `create-to-ready` exceeds the 15s regression threshold |

## Run it

```bash
bash scripts/k8s-vault-proof/bootstrap.sh
kubectl -n opensandbox-system port-forward svc/opensandbox-server 18082:80
python scripts/k8s-vault-proof/vault-proof.py --port 18082
```

Expected: a PASS line, with the upstream echoing the real secret even though the sandbox sent only
the placeholder.

### Measure cold start

Timed against the same live local cluster as the vault proof (see #589):

```bash
kubectl -n opensandbox-system port-forward svc/opensandbox-server 18082:80
python scripts/k8s-vault-proof/measure-cold-start.py --port 18082
```

Prints `create-to-ready` and `first-command` latencies and exits **2** if
`create-to-ready` exceeds the 15s regression threshold (~5× the 2.63s median).
This is a **manual/periodic check**, not a CI gate: cold start needs a live
cluster, which CI does not have. Baseline figures and the measurement conditions
live in the script's docstring.

## The five non-obvious fixes

1. **`OPENSANDBOX_CONFIG` env var.** The server resolves its config via
   `os.environ.get("OPENSANDBOX_CONFIG", DEFAULT_CONFIG_PATH)`, but the Helm chart sets only
   `SANDBOX_CONFIG_PATH`. With `OPENSANDBOX_CONFIG` unset the server falls back to
   `~/.sandbox.toml`, which does not exist in the pod, so it runs a default config with **no
   `[egress]`** and every `credentialProxy.enabled` request is rejected with
   `requires server [egress].mode = "dns+nft"`.
2. **Missing CRDs.** The base chart installs only `BatchSandbox`; `Pool` and `SandboxSnapshot`
   must be applied from `kubernetes/config/crd/bases/` or the controller crashloops.
3. **`OPENSANDBOX_INSECURE_SERVER=YES`.** A local server has no `api_key` and refuses to start.
4. **`sandbox_create_timeout_seconds`.** The default of 60 is too low: the egress sidecar
   (nftables, DNS proxy, mitmproxy) needs roughly 20-40s to pass readiness, so creation is flaky.
   The harness sets 300.
5. **`use_server_proxy=True`.** The SDK derives the vault URL from the sandbox endpoint, which
   defaults to the ingress-gateway host and does not resolve on the host machine. Server-proxied
   endpoints are reachable through the port-forward.

Leftover sandboxes exhaust the single minikube node, so delete them between runs:

```bash
kubectl -n opensandbox delete batchsandboxes --all
kubectl -n opensandbox delete pods --all
```

## Supply-chain note

The harness pulls a public Helm chart, an Alibaba-registry sidecar image and a helm binary at run
time. It is operator-run dev tooling and is deliberately **not** part of the CI trust boundary.

## Harmless noise

`fast_sandbox/cr_reader.py` watches plural `sandboxes` in group `sandbox.fast.io`, but only
`sandboxpools.sandbox.fast.io` is installed, producing a periodic 404 informer warning. The active
provider is `batchsandbox`, so this is cosmetic.

## Teardown

```bash
minikube delete
```
