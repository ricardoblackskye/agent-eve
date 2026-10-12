# Plan — #275: DF P2 — Security validation pass (injection / exfiltration / sandbox escape)

**Branch:** `feat/df-security-validation-275` (off `origin/main` @ `3a3f262`)
**Issue:** #275, sub-issue of #267 "Foundations towards UAT". **AC:** *documented findings + fixes for each vector.*

## Recon — done BEFORE planning (findings, not assumptions)

The posture is far stronger than the issue implies: most controls already EXIST. So this is a **validation pass** — prove each control with an adversarial test, fix the gaps found, document. Nothing here is greenfield.

| Vector | Existing control (file:line) | Status |
|---|---|---|
| **Prompt injection via issue body** | `entry.ts:116` `sanitizeIdentifier()` strips to `[A-Za-z0-9_.\-/]`; `toDispatchIntent` sanitises `repo` (`:139`) so the "verified identifier" label is truthful; `renderHandoffMessage` `defuse()`s backticks (`:158`) and fences title+body in a ```text block labelled DATA (`:201-212`); `architect-agent.ts:292` fences `<user_story>` as untrusted | Control PRESENT, **unproven by any test** |
| **Secret exfiltration (dev-agent env)** | `tester-agent.ts:57` filters child env to `ALLOWED_ENV_KEYS` = `NODE_PATH/PATH/HOME/LANG/LC_ALL` + command allowlist (`:55`); `diff-capture.ts` redacts `DF_*` from diffs | **REAL GAP: `developer-agent.ts:696` runs `execAsync(testCmd, { cwd, maxBuffer })` with NO `env` — the child inherits the FULL `process.env`** (push token, `DF_*`, DB URLs). The tester agent filters; the dev agent does not. This is exactly what the issue's "verify dev-agent env filtering like tester-agent" asks for |
| **Sandbox escape** | `developer-agent.ts`: metacharacter denylist (`:654`), token allowlist (`:667`), command-prefix allowlist (`:677`), fail-closed extension allowlist, `ALLOWED_TOOLS` (`:326`), path-traversal + symlink containment (`:297`, `:538`); `worker-env.ts:272` repo allow-list BEFORE provisioning, lease-only credential (AC5), `local` honestly `isolated:false`; `credentials.ts` broker never hands a token to a sandbox | Controls PRESENT, **unproven by any test** |

Existing security-adjacent tests: `credentials.test.ts`, `worker-env.test.ts`, `worker-policy-env.test.ts`, `env-docs.test.ts`. **No injection / escape / exfiltration adversarial suite exists.**

## Tasks (RED -> GREEN)

**T1 (RED) — adversarial suite** `tests/dark-factory/security-validation.test.ts`
- *Injection*: a hostile issue body that tries to close the fence and issue its own instructions -> assert the rendered handoff keeps the text INSIDE the fence, backticks defused, and a hostile repo (`'"'; rm -rf /`) collapses via `sanitizeIdentifier`.
- *Exfiltration*: unit-test the extracted env filter with a poisoned env (fake `GITHUB_TOKEN` + `DF_*`) -> assert they are dropped and `PATH` survives; plus a **source-level guard** that the `exec` call site actually passes `env:` (the same wiring-guard pattern used for the runner), so the unit test cannot pass while the call site stays unfiltered.
- *Escape*: traversal (`../`), absolute path, non-allowlisted extension, symlink escape -> assert refused.

**T2 (GREEN) — fix the dev-agent env gap.** Extract the allow-list into ONE shared helper reusing the tester agent's `ALLOWED_ENV_KEYS` (so the two seams cannot drift apart), and pass `env: filterChildEnv(process.env)` at `developer-agent.ts:696`.

**T3 (GREEN) — close any further gap T1 exposes.**

**T4 — the AC's "documented findings":** `docs/pages/dark-factory-security-review.md` — one row per vector with the finding, the control, and the test that proves it. ADR `0025` if a decision is recorded (0025 is the next free number). Catalog row if a module is added.

## Verification
Full suite green · `tsc` exit 0 **captured explicitly** (not through a pipe) · cspell + markdownlint on every changed file · **`npm run build`** (the gate I skipped on #318).
**Non-vacuity:** remove the env filter -> the exfiltration test FAILS; restore -> passes.

## Decisions to confirm
1. **Env allow-list breadth.** The tester's list is the precedent, but `npx vitest` may also want `TMPDIR`/`NODE_OPTIONS`. I will keep it MINIMAL and prove it with a real local `npx vitest` run through the filtered env, rather than guessing.
2. **Scope of "sandbox escape".** The local provider is honestly `isolated:false` (dry-run, nothing executes), so this vector is about the LOCAL dev agent's file + child-process confinement, not a container. Real isolation is #280 (R1). Confirming that reading.

## Out of scope
Real container isolation (#279/#280) · any `llm-policy`/`circuit-breaker` code change unless T1 finds a validation gap · the deferred #309.
