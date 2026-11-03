# #553 — Provision the OpenSandbox locally: remaining acceptance criteria

## Goal

Turn the proven-but-manual OpenSandbox local deploy into a **deliberate, reproducible provisioning core**
that a fresh machine can run from a checkout, with no run-time artifact fetch and no hand-run proofs —
closing AC1–AC6 of #553. #355 landed the proof harness; #570 fixed its Helm single-owner bug. What
remains is provenance, installer-run verification, a remote parameter, scripted teardown and fail-loudly.

## Verified current state (read from the tree, 2026-11-02)

| Artefact | What it gives us today |
| --- | --- |
| `scripts/k8s-vault-proof/bootstrap.sh` | Working deploy: minikube, Helm upgrade/install, the five fixes as Helm values, CRDs the chart omits, rollout wait, config assertion. **Helm is single owner** (#570 landed). |
| `scripts/k8s-vault-proof/vault-proof.py` | Real MITM substitution proof; exits 0 on PASS. |
| `scripts/df-sandbox-clean.sh` | Deletes leftover BatchSandboxes/pods, guarded by kubectl context. |
| `agent/lib/dark-factory/local-run-preflight.ts` | Pure preflight with injectable `reachSandbox` probe; checks driver/endpoint/image. |
| `agent/lib/dark-factory/sandbox-provider.ts` | `local` / `dry-run` / `opensandbox` driver selection, fail-closed. |
| `scripts/sandbox-image/` | Image build + `verify-image.ts`. |
| ADR 0050 | Local runs are provisioned deliberately: assert every prerequisite in one block. |
| ADR 0032 / 0035 / 0039 | Runner owns sandbox disposal; credentials live in a write-only vault; push trusts the egress CA. |

**Nothing is vendored.** No chart directory, no image cache, no digest manifest. `bootstrap.sh` does
`git clone --depth 1 …/OpenSandbox.git` and downloads the helm binary from `get.helm.sh` **at run time**,
and images come from `sandbox-registry.cn-zhangjiakou.cr.aliyuncs.com/...:release-1.1.1`.

### AC status against this tree

| AC | Status | Gap |
| --- | --- | --- |
| AC1 one command from Docker + checkout | partial | Hardcodes `/c/Program Files/.../minikube.exe` and `$LOCALAPPDATA/Temp/helm`; needs git/python/curl/unzip. |
| AC2 no run-time chart/image fetch | **not met** | Chart cloned, helm downloaded, images pulled at run time. |
| AC3 preflight + vault proof run from the installer | **not met** | Script prints instructions; operator runs both by hand. |
| AC4 same provisioning targets a remote cluster with one parameter | **not met** | `minikube start` hardcoded; no cluster/context parameter. |
| AC5 teardown documented and verified | partial | Sandboxes cleaned; no scripted `helm uninstall`/namespace removal/port check. |
| AC6 unresolvable image refuses naming it | partial | Docker-down is named; no pre-install image resolvability check. |

## Approach

Keep the **verified shell deploy as the executor** — rewriting it in TypeScript would risk the five
fixes — and put a **TypeScript provisioning core** in front of it. The core owns artifact resolution,
the parameter surface, the proof run and teardown; the script becomes a parameterised executor with no
run-time fetch of its own. This matches ADR 0050 (one launcher, all prerequisites asserted) and the
repo's established testing idiom (vitest unit tests over an injected `exec`, plus static assertions over
the script the way `sandbox-setup-single-owner.test.ts` already does).

## Tasks (TDD; each task = RED first)

### Task 1 — Vendor the chart and pin the images (AC2)

**Files**
- Create: `scripts/sandbox-vendor/vendor.sh` (populate a gitignored cache)
- Create: `scripts/sandbox-vendor/artifacts.lock.json` (chart ref + image digests)
- Create: `scripts/sandbox-vendor/README.md`
- Modify: `.gitignore` (ignore `scripts/sandbox-vendor/cache/`)

**RED:** `tests/dark-factory/sandbox-vendoring.test.ts` asserts `artifacts.lock.json` exists, every image
reference carries a `sha256:` digest, and the chart entry names a local path — not a git URL. Fails today.
**GREEN:** add the manifest and `vendor.sh` (`helm pull` into the cache; `docker pull` + `docker save`
per digest; `minikube image load` helper). The lock file is committed; the cache is not.

**Deviation to flag:** image *blobs* cannot be committed. "Vendored" for images means a committed digest
lock plus a gitignored cache populated by an explicit vendor step. AC2's "no run-time fetch" is satisfied
because `df:sandbox-up` **refuses** when the cache is empty instead of fetching. Approve or redirect.

### Task 2 — Provisioning core module (AC1, AC4, AC6)

**Files**
- Create: `agent/lib/dark-factory/sandbox-provisioning.ts`
- Create: `tests/dark-factory/sandbox-provisioning.test.ts`

**Interface**
```ts
export interface ProvisionOptions {
  workspaceDir: string;
  /** "minikube" (default) or an existing kube context — AC4's one parameter. */
  cluster: "minikube" | { context: string; kubeconfig?: string };
  forwardPort: number;
  artifactsDir: string;   // where the vendor cache lives
  exec: ExecFn;           // injected: every process call goes through this
}
export interface ProvisionResult {
  endpoint: string;
  proof: { preflightOk: boolean; vaultSubstitution: boolean };
}
```

**RED:** unit tests with a fake `exec` assert:
1. an image whose digest is absent from the local store is **refused with its name** (AC6);
2. an empty artifacts cache refuses and names `npm run df:sandbox-vendor` (AC2/AC6);
3. `cluster: {context}` is passed through as `--kube-context` and skips `minikube start` (AC4);
4. the call order is preflight-check → deploy → port-forward → vault proof (AC3).

**GREEN:** implement the module; every external command goes through the injected `exec`.

### Task 3 — Parameterise `bootstrap.sh` (AC1, AC2, AC4)

**Files**
- Modify: `scripts/k8s-vault-proof/bootstrap.sh`
- Modify: `tests/dark-factory/sandbox-setup-single-owner.test.ts` (keep #570 invariants)

**RED:** static tests assert the script (a) never `git clone`s or `curl`s when `CHART_DIR`/`HELM_BIN` are
supplied, (b) honours `KUBE_CONTEXT`, (c) resolves `minikube`/`helm`/`docker` from `PATH` before falling
back to env overrides, (d) refuses when an image reference is absent from the local store.
**GREEN:** replace the clone/download block with parameterised resolution; keep the five fixes and the
Helm single-owner behaviour untouched. The #570 test must still pass as a control.

### Task 4 — Installer runs the proofs (AC3)

**Files**
- Modify: `agent/lib/dark-factory/sandbox-provisioning.ts`
- Modify: `package.json` (`df:sandbox-up` → the TS module; keep the shell reachable as an escape hatch)

**RED:** the provisioning test asserts a failing `reachSandbox` probe or a failing vault proof makes
`provisionSandbox` return non-zero **and** that the port-forward is torn down on failure.
**GREEN:** wire `preflightLocalRun` with a real `reachSandbox` probe and run `vault-proof.py`; refuse
on either failure; always clean up the port-forward.

### Task 5 — Scripted teardown (AC5)

**Files**
- Create: `scripts/df-sandbox-down.sh`
- Modify: `package.json` (`df:sandbox-down`)
- Modify: `scripts/k8s-vault-proof/README.md`

**RED:** static test asserts the teardown runs `helm uninstall`, deletes both namespaces, kills the
port-forward and **fails if the port is still listening**; `--delete-cluster` additionally runs
`minikube delete`.
**GREEN:** implement, reusing the context guard from `df-sandbox-clean.sh`.

### Task 6 — Docs: one runtime, one endpoint (AC1, AC5)

**Files**
- Modify: `scripts/k8s-vault-proof/README.md`, `docs/pages/dark-factory-local-runs.md`

**RED:** doc-drift guard asserts the documented endpoint matches the script's default port and that the
vendor step is named before `df:sandbox-up`.
**GREEN:** rewrite the run/teardown sections.

### Task 7 — Full gates, then PR

`npm run lint`, `npm run typecheck`, `npm test`, and the repo's markdown/cspell checks. PR body uses
`Part of #553` while AC4's remote path is only parameterised (not proven against a real remote cluster —
that stays #344).

## Acceptance mapping (target end-state)

| AC | Lands in |
| --- | --- |
| AC1 one command, no manual clone/download/CRD apply | T2 + T3 + T6 |
| AC2 no run-time chart/image fetch | T1 + T3 |
| AC3 preflight + vault proof from the installer | T2 + T4 |
| AC4 one parameter for a remote cluster | T2 (`cluster` option) + T3 (`KUBE_CONTEXT`) |
| AC5 teardown verified | T5 + T6 |
| AC6 unresolvable image refuses naming it | T2 + T3 |

## Risks and deviations to flag at GATE 1

1. **Image blobs cannot be committed.** Digests + gitignored cache + refuse-when-empty is the proposal
   above. If "vendored" must mean blobs in the repo, say so and I will re-scope (large binary payload).
2. **Chart vendoring size.** The umbrella chart is text; committing it is cheap and makes AC2 literal.
   Confirm you want it in-tree rather than cache-only.
3. **Windows-first paths.** The harness is Windows-specific today. T3 makes resolution portable
   (PATH first, env override second) but does not port the script to Linux/macOS in this change.
4. **`df:sandbox-up` semantics change.** Moving it from the shell script to the TS module means an
   empty cache now **refuses** instead of silently fetching. That is the AC2/AC6 intent, but it is a
   behaviour change for anyone relying on the old auto-download.
5. **AC4 is parameterisation, not a remote proof.** Standing up a real remote cluster is #344 and stays
   out of scope; merging this leaves #553 open only if you require the remote proof inside it.

## Out of scope

- The remote end-to-end proof (#344).
- Reply-watching so a parked run resumes (#380).
- Scaling, pools and cost optimisation.
- Inverting the default run posture (#383).

## Open questions for GATE 1

1. Chart in-tree or cache-only?
2. Teardown default: release+namespaces+port only, or also `minikube delete`?
3. Keep the raw `bootstrap.sh` as a documented escape hatch, or make the TS module the only entry point?
