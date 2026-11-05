# #603 — Binary acquisition ownership & manifest verification

- **Parent epic:** #584 (Portfolio Epic: Windows setup program for Eve and the sandboxes)
- **Status:** planning — opt-in approval required (any comment = plan feedback, not approval)
- **Branch:** `feat/603-binary-manifest-verify` (based on `origin/main` @ `a2e715c`)
- **Trigger label:** `dark-factory`

## Decisions locked (owner review, recorded on #603)

1. **Refuse clearly, don't fail mid-deploy.** When a required tool (docker / kubectl / helm /
   minikube / python) is absent or unusable, the CLI must refuse *early* — name the binary and
   point at the vendor install / program acquisition step — instead of starting provisioning and
   blowing up halfway through a deploy. Reuses the existing `refuse()` path.
2. **The repo owns the manifest even if the program downloads.** The binary manifest (versions +
   digests) lives in this repo next to `artifacts.lock.json`, so "which binaries did this run use"
   stays answerable from source. The Phase 2 program may perform the download, but the CLI reads
   the manifest and does not hard-code versions.
3. **The CLI verifies the manifest and refuses on mismatch.** If an installed/acquired binary does
   not match the manifest (wrong version, or digest where one is recorded), the CLI verifies and
   refuses before any provisioning stage runs. Extends `digestOfFile` coverage from chart/images to
   the binaries.

## Current state (what exists today)

- `scripts/sandbox-vendor/artifacts.lock.json` tracks `chart`, `crds`, `images` (with digests).
  **It does not track the CLI binaries at all.**
- `agent/lib/dark-factory/sandbox-check.ts` (#585 T5) is a read-only preflight. It probes
  docker/kubectl/helm/python (+minikube for a local target) for *presence only* and checks the
  vendor lock + image cache. Returns `prerequisites-missing` (exit 10) / `artifact-unresolvable`
  (exit 11).
- `agent/lib/dark-factory/sandbox-state.ts` already has `digestOfFile`.
- `scripts/sandbox-up.ts`: `--check` runs the preflight and returns. **`provisionSandbox` is NOT
  gated on the preflight** — so a missing/mismatched binary currently fails mid-deploy, which is
  exactly the Decision #1 violation we are closing.

## Acceptance criteria

- **AC1 (D1):** `provisionSandbox` refuses before any mutating stage when a required binary is
  missing — it names the binary and the install/vendor step (reuse `prerequisites-missing`, exit
  10). Proven by a test asserting no vendor/deploy `exec` calls occur when a binary is absent.
- **AC2 (D2):** `artifacts.lock.json` gains a `binaries` section owned in-repo, listing each
  required CLI binary with `versionConstraint`, `required`, and `acquiredBy`
  (`program` | `operator`).
- **AC3 (D3):** `sandbox-check` (and the provisioning gate) verify each *present* binary's version
  against `versionConstraint`; a mismatch yields a new `prerequisites-mismatch` (exit **15**)
  carrying the expected vs actual version.
- **AC4 (D3):** when a manifest entry carries `expectedDigest` (or the program writes a `.sha256`
  sidecar), the CLI verifies it via `digestOfFile` and refuses on mismatch.
- **AC5:** the manifest is parsed by a typed `sandbox-manifest.ts`; a missing/garbled entry fails
  closed (refuse) rather than silently proceeding.
- **AC6:** help (`USAGE`), `docs/pages/dark-factory-local-runs.md`, and the doc-drift guard all
  cover the new code. The Windows CI job already exercises the check suite (from #585 T7).

## Tasks (TDD, RED → GREEN)

- **T1 — manifest schema.** New `agent/lib/dark-factory/sandbox-manifest.ts` exporting a typed
  `Binaries` parser + the `binaries` section added to `artifacts.lock.json`. **RED:** a schema test
  fails (no `binaries` key / missing fields). **GREEN:** typed parse + lock file updated. No
  `semver` dep present → ship a tiny `satisfiesRange()` (`>=`, `==`, `^`) in this module; do not
  add a dependency for binary pins.
- **T2 — version probe + range compare.** Extend `sandbox-check.ts` to read `binaries`, probe each
  binary's version, and compare to `versionConstraint`. **RED:** a test where helm is present but
  wrong version produces `prerequisites-mismatch`. **GREEN:** comparison + code. Probe command/args
  live in the manifest entry so the list stays data-driven, not hard-coded.
- **T3 — new exit code.** Add `prerequisites-mismatch: 15` to `ProvisionProblemCode` and
  `EXIT_CODES` in `sandbox-exit-codes.ts`; update the docs table and the doc-drift guard
  (`sandbox-cli-docs.test.ts`). **RED:** guard fails (no row for the new code). **GREEN:** passes.
- **T4 — early refusal in provisioning.** Gate `provisionSandbox` on `checkPrerequisites` at entry
  (or in `sandbox-up.ts` before the non-`--check` call) so missing/mismatched binaries refuse with
  no mutation. **RED:** test asserting provision halts before vendor/deploy exec calls. **GREEN:**
  the gate. This is the concrete Decision #1 fix — `--check` and real runs now share one verify
  path.
- **T5 — digest sidecar verify.** When a manifest entry carries `expectedDigest` (or a sidecar
  exists), verify with `digestOfFile` and refuse on mismatch. **RED:** test where actual digest ≠
  manifest. **GREEN:** verify + refuse.
- **T6 — docs + guards.** `USAGE`, `dark-factory-local-runs.md`, doc-drift guard. Windows CI
  already covered by #585 T7; confirm it still passes.
- **T7 — PR.** Open `feat/603-binary-manifest-verify` → `main`, referencing #603 with the three
  decisions quoted.

## Risks / notes

- **R1:** version probing differs per binary (`helm version --short` vs `kubectl version --client`).
  Each manifest entry carries its own `probe` command/args so the code stays generic.
- **R2:** `prerequisites-mismatch` is exit **15** (next free after `teardown-failed: 14`). The #585
  doc-drift guard requires a docs row for every code — T3 covers it.
- **R3:** gating `provisionSandbox` on the preflight means `--check` and real runs share one verify
  path — directly removes the mid-deploy failure mode the epic set out to kill.
- **R4:** the manifest is the single source for *what* to acquire; the Phase 2 program stays the
  *how*. AC2 keeps it in-repo, so "which binaries did this run use" is answerable from git history.

## Release split

Single PR. All tasks land together; no epic split needed.
