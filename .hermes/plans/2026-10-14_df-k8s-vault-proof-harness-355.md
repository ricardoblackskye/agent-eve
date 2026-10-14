# Land the local-K8s Credential Vault proof harness (dev tooling)

**Issue:** #355 (follow-up to closed #353, under #352) · **Branch:** `feat/k8s-vault-proof-harness-355`

**Goal:** Commit the _already-proven_ local-Kubernetes OpenSandbox credential-vault proof harness
to the repo as tracked dev tooling, so a vault-capable cluster can be re-created and the
secret-injection property re-verified without re-deriving hours of diagnosis.

## Why this exists (verified context)

Issue #353 was closed because the blocker was removed and verified live: the Credential Vault runs on
Kubernetes and transparent secret injection was observed end-to-end (a sandbox that only ever held
a placeholder caused the upstream to receive the real secret). The entire diagnosis lived in
throwaway scripts under `%LOCALAPPDATA%\Temp` and imperative `kubectl` calls, so nothing about the
proven configuration was durable or re-runnable.

The blocker's root cause is the thing a future developer must not re-derive:

- The credential vault is **Kubernetes-only** — `runtime.type="docker"` hard-rejects it with
  `secureAccess is not supported when runtime.type='docker'`.
- On K8s it still failed until the server actually _loaded_ the config: it resolves config via
  `os.environ.get("OPENSANDBOX_CONFIG", DEFAULT_CONFIG_PATH)`, but the Helm chart sets only
  `SANDBOX_CONFIG_PATH`. So `OPENSANDBOX_CONFIG` stayed empty, the server fell back to
  `~/.sandbox.toml` (absent in the pod) and ran a default config with **no `[egress]`**, making
  every `credentialProxy.enabled` request fail with `requires server [egress].mode = "dns+nft"`.

A working bundle already exists locally and has been executed successfully
(`PASS - real secret injected by MITM substitution`). This task lands it.

## What lands

New directory `scripts/k8s-vault-proof/`:

| File             | Purpose                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `README.md`      | What it proves, the five non-obvious fixes, run + teardown instructions                                      |
| `bootstrap.sh`   | Idempotent local deploy: minikube, helm, umbrella chart, missing CRDs, the three env fixes, config assertion |
| `vault-proof.py` | End-to-end assertion script; exit 0 on proven substitution                                                   |

## Out of scope

- No production/runtime code changes. This is dev tooling; the dark-factory driver stays
  runtime-agnostic and is untouched here.
- The dark-factory-specific E2E (real push token + provider key) is **#354**-tracked separately —
  it depends on the #282 R3 driver wiring, which does not exist yet.
- No CI wiring. The harness needs Docker + minikube and is operator-run, not a CI job.

## ADR decision (made now, per the workflow)

**No new ADR is required.** This change adds no vendor, seam, adapter, or runtime contract: it is
an operator-run dev script behind no product surface. The K8s-only constraint of the vault is
already recorded in the ADR added by #282. If a future change makes the harness a required CI
dependency, that (different) decision would warrant its own ADR.

## Tasks

### Task 1 — README

**Objective:** Document what the harness proves and how to run it.

**Files:** Create `scripts/k8s-vault-proof/README.md`.

Content: the K8s-only constraint, the root-cause explanation, the five fixes (env var, CRDs,
`OPENSANDBOX_INSECURE_SERVER`, `sandbox_create_timeout_seconds`, `use_server_proxy`), teardown,
and the harmless `sandbox.fast.io` informer 404.

**Validation:** `npx -y markdownlint-cli@0.45.0 -c {"default":false,"MD040":true} <file>` clean;
tables normalised with `npx -y markdown-table-formatter@1.6.1`.

### Task 2 — bootstrap.sh

**Objective:** One idempotent command that produces the working cluster.

**Files:** Create `scripts/k8s-vault-proof/bootstrap.sh`.

Must encode every non-obvious step: `set -euo pipefail`; start minikube if not running; clone the
OpenSandbox chart repo if absent; fetch the helm binary; **generate the signing key at runtime**
(never commit one); write the proven `config.toml`; `helm upgrade --install` with subchart values
under the dependency name (`opensandbox-server.*`, `ingress-gateway.*`); apply the missing `Pool`
and `SandboxSnapshot` CRDs; apply the ConfigMap; apply the three env fixes
(`OPENSANDBOX_INSECURE_SERVER=YES`, `OPENSANDBOX_CONFIG=/etc/opensandbox/config.toml`, and the
`300` create timeout in the config); assert the loaded config in-pod.

**Validation:** `bash -n scripts/k8s-vault-proof/bootstrap.sh` (syntax) plus a real end-to-end run
on this machine.

### Task 3 — vault-proof.py

**Objective:** The assertion script that proves injection.

**Files:** Create `scripts/k8s-vault-proof/vault-proof.py`.

Creates a sandbox with `credentialProxy.enabled` and an egress `networkPolicy` (deny default,
`httpbin.org` allowed) with `use_server_proxy=True`; writes a credential + a `passthrough`
substitution binding; then, from _inside_ the sandbox, sends only the placeholder and asserts the
upstream received the real value. Exit code 0 on success, 1 otherwise. It must destroy the sandbox
afterwards.

**Validation:** execute against a live bootstrapped cluster; expect exit 0.

### Task 4 — secret hygiene and gates

**Objective:** Nothing sensitive ships and the repo's linters pass locally.

**Steps:**

1. Confirm no key/secret is committed: `git grep -nE "BEGIN [A-Z ]*PRIVATE KEY|ghp_|github_pat_|sk-" -- scripts/k8s-vault-proof/` returns nothing.
2. Run the repo's local gates on the new files: prettier check, `npx -y cspell@8 --config .cspell.json scripts/k8s-vault-proof/*` (add missing technical words to `.cspell.json`), and markdownlint/table-formatter for the README and this plan.
3. `bash -n` the shell script and `python -m py_compile` the Python script.

**Validation:** all four clean; no CI lint findings outstanding.

### Task 5 — commit

**Objective:** One plan commit already pushed; the implementation as its own commit.

**Steps:** `git add scripts/k8s-vault-proof .hermes/plans/<this plan> .cspell.json`; commit
`docs(df): add local k8s credential-vault proof harness (#354)`.

## Files likely to change

| Path                                                         | Change                             |
| ------------------------------------------------------------ | ---------------------------------- |
| `scripts/k8s-vault-proof/README.md`                          | create                             |
| `scripts/k8s-vault-proof/bootstrap.sh`                       | create                             |
| `scripts/k8s-vault-proof/vault-proof.py`                     | create                             |
| `.cspell.json`                                               | modify — technical vocabulary only |
| `.hermes/plans/2026-10-14_df-k8s-vault-proof-harness-354.md` | create                             |

## Validation (definition of done)

- `bash bootstrap.sh` on a clean machine produces a healthy control plane and asserts the loaded
  `egress.mode = dns+nft`, i.e. the config fix is effective.
- `python vault-proof.py --port <forward>` exits 0 and prints the PASS line.
- No secret of any kind is committed (grep in Task 4 is empty).
- Repo linters pass locally on every changed file, including this plan.

## Risks and open questions

- **Supply chain:** the harness pulls a public Helm chart, an Alibaba-registry sidecar image, and a
  helm binary at runtime. It is operator-run dev tooling, not a build dependency, so it is not in
  the CI trust boundary — but the README must say so plainly.
- **Reproducibility drift:** the OpenSandbox chart is pinned only by `main` at clone time. Record
  the verified version (`1.1.1`) in the README; a future mismatch is the first thing to check.
- **Open question:** should the harness also pin the chart to the verified tag rather than
  `--depth 1` of the default branch? Proposed: yes, record the tag in the README now; switch to a
  pinned checkout only if drift actually bites.
