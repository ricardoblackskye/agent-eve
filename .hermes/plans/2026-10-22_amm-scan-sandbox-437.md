# AMM scanner R3 — run the command checks in an isolated sandbox (#437) Implementation Plan

**Goal:** Make the catalogue's five `command` checks measurable — executed inside an isolated `SandboxProvider` — while keeping AC5: an unmeasured check is never reported as absent, and no command ever runs on the host.

**Architecture:** `runAmmScan` already accepts a `provider`; the CLI never supplies one. R3 supplies one, but only when it reports `isolated: true`, extends what the isolated driver will execute to the catalogue's own command set, and refuses to measure a sandbox that does not actually hold the repository.

**Tech Stack:** TypeScript + tsx + vitest; OpenSandbox over Kubernetes; no new dependencies.

---

## Verified current state (read, not assumed)

| Fact                                                    | Evidence                                                                                                 |
|---------------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| The CLI never passes a provider                         | `scripts/amm-scan.ts:64-68` calls `runAmmScan({ repo, workspace, layout? })`                             |
| So command checks always refuse                         | `amm-scan-runner.ts:123` — `input.provider ?? createRefusingSandboxProvider(REFUSAL)`                    |
| The five commands                                       | `amm-signals.ts` — `npm run lint`, `npx tsc --noEmit`, `npm run validate`, `npm ci`, `npm run test:unit` |
| An isolated endpoint is UP in this environment          | `curl 127.0.0.1:18082/health` -> `200`; `kubectl`, `minikube`, `docker` all present                      |
| **An unset driver resolves to `local`, NOT refusing**   | `sandbox-provider.ts:12` and `:74-76`                                                                    |
| **`local` is not isolated**                             | `sandbox.ts:40-42` — "`local`, `dry-run` and `refusing` are all NOT isolated"                            |
| **The isolated driver permits only 3 command prefixes** | `developer-agent.ts:506-510`, enforced at `opensandbox-driver.ts:177-186`                                |

The last three rows are the shape of this issue, and each was invisible from the issue text:

1. **Wiring the factory in naively runs the checks on this host.** An unset `DF_SANDBOX_DRIVER` resolves to `local`, so the scan must gate on the provider's `isolated` property — never on the driver name, and never on "a provider was configured".
2. **Only one of the five commands is permitted today.** `npx tsc --noEmit` matches the `npx tsc` prefix; `npm run lint`, `npm run validate`, `npm ci` and `npm run test:unit` do not, so the driver throws `InvalidTaskError`, `measureCommand` catches it, and the row stays `unmeasured`. Wiring alone would move the total from 5 unmeasured to 4.
3. **An empty sandbox workspace yields a FALSE `absent`, not `unmeasured`.** `measureCommand` returns `absent` when the command runs and exits non-zero, and every one of these commands fails in a directory with no project. So a sandbox that does not hold the repository must be detected BEFORE the command runs.

## Intended change

### Part 1 — select a provider by isolation, not by name

In `scripts/amm-scan.ts`, resolve the configured provider and use it only when it is isolated:

- Resolve via `createSandboxProvider()` (respecting `DF_SANDBOX_DRIVER`, matching every other DF entry point).
- `provider.isolated === true` -> pass it to `runAmmScan`.
- Otherwise -> keep the refusing provider, so command checks stay `unmeasured`, and say which driver was resolved and why it was not used.
- Print the resolved driver in the CLI's stderr summary, so a scan states whether its command checks were measured or refused.

No new flag: the driver env already selects the backend, and a flag would be a second way to say the same thing.

### Part 2 — what the scan may execute (DECISION NEEDED)

Keep the Developer Agent's list untouched and let the scan state its own, derived from the catalogue:

- The catalogue is already the authority for which commands the scanner runs, and its rows are repo-defined constants, not user input.
- Widen the seam (an optional allowlist on the provider's workspace tools) rather than the shared constant, so the agent's blast radius does not change.
- The alternative — adding `npm run lint`, `npm ci`, `npm run validate` and `npm run test:unit` to `ALLOWED_TEST_COMMAND_PREFIXES` — is one line but widens what the Developer Agent may execute, and `npm ci` runs a repository's lifecycle scripts. Recommend against.

### Part 3 — never measure an empty sandbox

Before the first command check, confirm the sandbox workspace holds the repository (its `package.json` is present). If it does not, every command row is `unmeasured` with a reason — a sandbox we could not prepare is exactly the "nobody looked" case, and reporting `absent` there would fail a repository on our own misconfiguration.

## Decisions — CONFIRMED

- **The project image is IN R3 (Option A).** The five commands need the repository and its dependencies
  inside the sandbox, so building and loading `DF_SANDBOX_IMAGE` is part of this deliverable, not a
  follow-up. The end-to-end proof is a scan that reports real measured results.
- **The scan's command set comes from its catalogue** (Part 2): the isolated driver receives a
  catalogue-derived allowlist on the scan path, and the Developer Agent's shared
  `ALLOWED_TEST_COMMAND_PREFIXES` is left untouched. Chosen because widening the shared constant would
  let the Developer Agent execute `npm ci`, i.e. a repository's lifecycle scripts.
- **A refusal must carry its reason** (risk 2). "Not allowed by the allowlist", "no isolated sandbox
  configured" and "the sandbox holds no project" are three different situations and an operator cannot
  act on a single opaque `unmeasured`.
- **Health-check the endpoint before the run** (risk 4). The port-forward dies on a pod or machine
  restart, so the end-to-end step probes `/health` first and reports the endpoint as the cause rather
  than blaming the scan.

## Tasks (TDD, RED then GREEN as separate commits)

### Task 1: the scan refuses a non-isolated provider

- Test: a provider stub with `isolated: false` and a `runTests` spy -> command rows are `unmeasured` AND the spy was never called.
- Test: `isolated: true` -> the command is executed.
- Evidence: the spy assertion is the AC5 guarantee; a result-only assertion passes if the command ran on the host.

### Task 2: an unset driver does not mean the host

- Test: `createSandboxProvider({})` -> the resolved provider is NOT isolated, so the CLI path refuses.
- Evidence: pins the `sandbox-provider.ts:12` default against AC5, so a future change to that default fails this test rather than silently running commands on a laptop.

### Task 3: the catalogue's commands are permitted in the sandbox

- Test: each of the five catalogue commands is accepted by the scan's allowlist; a command outside the catalogue is refused.
- Test: the Developer Agent's `ALLOWED_TEST_COMMAND_PREFIXES` is unchanged (the agent's blast radius must not widen).
- Evidence: without this, four of five rows stay `unmeasured` however well Part 1 is wired.

### Task 4: an unprovisioned sandbox reports unmeasured, not absent

- Test: an isolated provider whose workspace lacks `package.json` -> every command row is `unmeasured` and no command was run.
- Test: a populated workspace whose command exits non-zero -> that row IS `absent` (the control case, so the guard cannot simply return `unmeasured` for everything).

### Task 5: the CLI resolves and reports the driver

- Test: with an isolated driver configured, the summary names it; with a non-isolated one, the summary says the driver was refused.
- Test: `--repo`/`--workspace`/`--layout` parsing is unchanged.

### Task 6: the project image

- Build `DF_SANDBOX_IMAGE` so the sandbox carries the repository AND its dependencies, with the three host-only traps handled: a baked git identity, `core.autocrlf true`, and no fetch-at-test-time (install any test-time tool with `--no-save`).
- Gate: `git status --porcelain` is EMPTY and the suite passes under `docker run --network none` — the sandbox's deny-by-default egress is what `--network none` models.
- Tag explicitly, never `latest`, so `imagePullPolicy` cannot try to pull over the loaded image.

### Task 7: load the image and verify the sandbox holds the project

- `minikube image load <tag>`, then create a sandbox and assert its workspace contains `package.json`. This is the preflight from Task 4, proven against the real backend rather than a stub.
- Health-check the endpoint FIRST (`/health` -> 200) so a dead port-forward is not misreported as a scan fault.

### Task 8: the measured end-to-end run

- `npm run df:amm-scan -- --repo ricardoblackskye/agent-eve --workspace .` with `DF_SANDBOX_DRIVER=opensandbox`, and report the measured-count delta (5 unmeasured before).
- Report each row that stays unmeasured WITH its reason, and never claim a measured result the run did not produce.

## Files likely to change

- `scripts/amm-scan.ts` — resolve the provider, gate on isolation, print the driver.
- `agent/lib/dark-factory/amm-scan-runner.ts` — the workspace preflight; carry a refusal reason.
- `agent/lib/dark-factory/opensandbox-driver.ts` — accept an optional command allowlist.
- `agent/lib/dark-factory/developer-agent.ts` — export the catalogue-derived list, leave the constant alone.
- `tests/dark-factory/amm-scan-runner.test.ts`, `tests/dark-factory/amm-scan-provider.test.ts` — the cases above.
- `docs/adr/0053-...` + `docs/adr/README.md` — the Part 2 decision.
- `docs/pages/dark-factory-modules.md` — only if a new module is added; existing modules are already listed.

## Validation

- `npx vitest run tests/dark-factory` then the FULL suite (a contract change gets the whole suite, not a hand-picked set).
- `npx tsc --noEmit --incremental false` (Vitest strips types and will not catch a type error).
- `npx cspell@9.1.1 -c .cspell.json` on changed files, plus the pinned markdown linters on this plan.
- The local `df:amm-scan` run, with the measured-count delta as evidence.

## Risks and open questions

1. **The sandbox must hold the project for anything to become present.** All five commands need the repository and its dependencies. The documented route is a project image (`DF_SANDBOX_IMAGE`) with the three host-only traps handled (git identity, `core.autocrlf`, no fetch-at-test-time) — see the `opensandbox-local-deploy` skill. `npm ci` additionally needs registry egress, which the sandbox denies by default, so it may be legitimately unmeasurable without an egress allowance. **DECIDED: in R3 (Option A).** The image is built and loaded as part of this deliverable, and the end-to-end scan is the proof. If `npm ci` cannot reach the registry even with the image in place, `fresh-checkout` is reported unmeasured WITH that reason rather than forced to a result.
2. **A refused command currently surfaces as `unmeasured` with no reason.** Part 3 should carry the reason through, otherwise "not allowed" and "nobody configured a sandbox" are indistinguishable to an operator.
3. **`npm ci` executes a repository's lifecycle scripts.** Inside an isolated sandbox that is the point, but it is the strongest argument for the scan's allowlist being catalogue-derived rather than widened in the shared constant.
4. **The running endpoint may not survive a reboot.** The port-forward dies silently; the plan's end-to-end step must health-check it first rather than assuming.

## ADRs to add

- `0053` — the AMM scanner's command set comes from its catalogue, not from the shared test-command allowlist. Context: two callers with different legitimate command sets and one shared constant; Decision: the scan passes its own catalogue-derived allowlist to the isolated driver and the agent's constant is unchanged; Consequences: the agent's blast radius does not widen, `npm ci`-style commands are reachable only on the scan path, and a future change to either list is a deliberate one.
