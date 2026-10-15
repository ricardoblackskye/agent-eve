# Plan — #358 Dark Factory E2E: run the coding loop inside the sandbox

- **Issue:** #358 (child of #352)
- **Branch:** `feat/df-sandbox-image-358`
- **Depends on:** ADR 0036 / #354 (the vault push path) — landed and live-proven

## Goal

Let a real Dark Factory run execute the developer loop **inside** the sandbox, so that its test step
actually runs there. Everything else is already wired: the execution seam (#280), the author seam and
governed gateway (#281), and the credential-vault push path (#282 / #354). What is missing is the
**project** in the sandbox.

## Verified premise

- Nothing gives the sandbox the repository or its dependencies. `git_clone` appears only as an
  allowed-tool **name** in `developer-agent.ts`; no clone and no dependency install exists anywhere in
  the pipeline.
- The default `DF_SANDBOX_IMAGE` is `python:3.12`, which has no Node toolchain, so the loop's
  `npx vitest run` cannot pass.
- ADR 0036 records the decision (option A3): the image carries the project, and the in-sandbox clone
  is only a fallback for an image that lacks it.
- Local prerequisites confirmed: minikube **v1.39.0** at the harness's pinned path
  (`/c/Program Files/Kubernetes/Minikube/minikube.exe`), profile on the **containerd** runtime — so an
  image must be **loaded**, not pulled — and Docker 29.6.1.

## Intended fix

Ship a sandbox image (`scripts/sandbox-image/`) built `FROM node:24-bookworm` that:

1. installs `git`, because the run commits and pushes from inside the sandbox;
2. installs dependencies **inside the image** with `npm ci` — the host's `node_modules` is
   Windows-native, so its compiled native bindings would be the wrong platform;
3. copies the project **including `.git`**, so the workspace is already a work tree and the git flow
   never attempts a clone (which would need a credential the sandbox must not have).

Then record the exact load command so the run is reproducible, and document the requirement where an
operator will look.

**This is a deployment input, not new branching logic.** No production code change is expected; if the
in-sandbox run exposes a real behaviour gap, it gets fixed with TDD and added here.

## Tasks

- **T1** — image + `Dockerfile.dockerignore` under `scripts/sandbox-image/`, built and sanity-checked
  (`node -v`, `git --version`, `node_modules` and `.git` present).
- **T2** — load into minikube; verify the tag is visible to the cluster.
- **T3** — prove the **loop's test step** runs inside a sandbox built from that image, driving the real
  driver (`createOpenSandboxProvider` + `createLiveSandbox`) **without** the vault gate: no token, no
  model spend, and no writes to the repository.
- **T4** — docs: README beside the Dockerfile, plus the operator command sequence.
- **T5** — the **full runner E2E** (real model calls, a pushed throwaway branch, a PR). Only with the
  user's explicit go-ahead, because it spends real credit and writes to the repository.

## Files likely to change

- `scripts/sandbox-image/Dockerfile` (new)
- `scripts/sandbox-image/Dockerfile.dockerignore` (new)
- `scripts/sandbox-image/README.md` (new)
- `.env.example` — only if a new variable proves necessary (none expected)

## Validation

- **Image sanity:** `node -v`, `git --version`, and `node_modules`, `.git`, `package.json` present in
  the image.
- **Cluster visibility:** the tag appears in the cluster's image list.
- **In-sandbox execution:** `npx vitest run <one test file>` executes INSIDE a sandbox built from the
  image and exits 0, driven through the real driver.
- **Regression:** the host's full suite stays green, `tsc --noEmit --incremental false` is clean, and
  the repo's lint gates are clean on the changed files.

## Risks / open questions

- **Image size is ~3.1 GB**, dominated by `node_modules` and `.git`. Fine for a local E2E; a
  deployment would want a slimmer or layer-cached build.
- **The image is an input, not a fix.** A deployment that supplies no such image still cannot run the
  loop in a sandbox — by design, per ADR 0036.
- **The full E2E needs a real provider key** seeded into the host-side gateway vault, and it writes to
  the repository (a throwaway branch and a PR). That requires explicit approval, so this plan stops
  short of it.

## ADRs

No new ADR: 0036 already records the image requirement. This issue implements it.
