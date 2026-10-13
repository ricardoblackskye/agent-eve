# Plan — #281: Sandbox coding-agent author seam + governed model gateway (R2 of #279)

**Branch:** `feat/df-agent-cli-author-279`
**Issue:** [#281](https://github.com/ricardoblackskye/agent-eve/issues/281) · parent epic [#279](https://github.com/ricardoblackskye/agent-eve/issues/279)
**Release:** R2 of 3 (R1 #280 merged; R3 #282 credential vault)

## Preconditions — checked BEFORE planning

| precondition | status |
|---|---|
| R1 execution seam | **merged** (`e6dbeab`); `DF_SANDBOX_DRIVER=opensandbox` deliberately **refuses** on main today — R2 adds that arm |
| OpenSandbox can be self-hosted | **yes**, Docker Engine 20.10+ / Python 3.10+ / `uv`. **No vendor key**: a server API key is one we mint, and it is optional |
| This host can run T0 | **yes** — Docker 29.6.1 (daemon running), Python 3.11.15, uv 0.12.14 |
| Model credential | **not required** for the mock-first path; the live OpenRouter leg switches on behind the same seam |
| Gateway upstream | OpenRouter, already the repo's provider (`agent/chat-model.ts`, `https://openrouter.ai/api/v1`) |

**Consequence:** the release is verifiable end to end on this laptop. The only thing an OpenRouter key
buys is the *live* model leg, and that is deliberately last.

## T0 (FIRST) — provisioning automation + a real smoke proof

The platform comes up before any seam code exists:
- **Deliverables:** a bring-up script + config template (`~/.sandbox.toml` equivalent) + health check,
  optionally a compose file, so the same automation works locally and on any Docker or Kubernetes host.
- **Smoke proof:** `Sandbox.create(...)` -> `commands.run(...)` -> `files.read_file` / `write_files` ->
  `sandbox.destroy()`, run here and pasted into the PR body.
- **Why first:** every later task is unverifiable without it, and it needs no key — so it is the one
  part of R2 that can be proven real rather than mocked.

## T0 — DONE, verified on this host

The platform is up and the client path is proven. Deliverables: `scripts/sandbox-server-up.sh`
(idempotent bring-up + health wait), `scripts/sandbox-smoke.ts` (`npm run df:sandbox-smoke`), and the
`@alibaba-group/opensandbox` client dependency.

**Measured evidence** (Docker 29.6.1, Windows/Docker Desktop):
- `bash scripts/sandbox-server-up.sh` -> starts the server, `{"status":"healthy"}`; a second run reports
  `already healthy` and exits 0 (idempotent).
- Smoke: created `baed7782-...`, ran `python -c 'print(41 + 1)'` -> `42`, wrote and read a file back,
  then `kill()` + `close()`.
- **No orphans**: `docker ps -a` shows no sandbox containers afterwards, and the server log confirms
  `kill sandbox container` / `remove sandbox container` / `DELETE /v1/sandboxes/<id>` 204.
- The TS SDK used `use_server_proxy=false` and reached the container directly, so the config's
  `resolve_internal` caveat (a macOS launchd/systemd issue) does not apply here.

### Four findings that change R2's implementation

1. **A client timeout during CREATE leaks the sandbox.** The first attempt hit the SDK's 30s default
   while the server was still building the container; the server returned 202 and finished anyway,
   leaving `sandbox-5c118427-...` running with no id known to the client — an orphan, i.e. a leak AND
   spend. It had to be reaped by hand. **R2 requirement:** bound create with a generous client timeout
   (raised to 180s here) AND reap by label/run-id (or a short server-side TTL), so a leaked sandbox
   cannot survive a failed create.
2. **The JS SDK tears down with `kill()` + `close()`, not `destroy()`** (the Python API's name). The
   issue text says `destroy()`; corrected here and in the issue.
3. **Native-tool paths are not translated.** Passing `$HOME/.sandbox.toml` to native `uvx` makes the
   server silently miss the config and die with a misleading `AppConfig: runtime Field required`. The
   script converts via `cygpath -w` when available — this is why the automation, not a hand-run, is the
   deliverable.
4. **An empty `api_key` needs explicit acknowledgment** for a non-interactive start
   (`OPENSANDBOX_INSECURE_SERVER=YES`). The script sets it only when no key is supplied, so a
   keyed/remote server can never take the insecure path by accident.

## Tasks (RED -> GREEN)

1. **T1 — author seam** `agent/lib/dark-factory/code-author.ts`: canonical `CodeAuthorTask` payload +
   `CodeAuthorProvider` interface + a **fail-closed refusing default** + an `in-process` adapter that
   preserves today's `streamText` loop as the DEFAULT (zero behaviour change when unset).
2. **T2 — author factory** `agent/lib/dark-factory/code-author-provider.ts`: `DF_CODE_AUTHOR`
   (`in-process` default | `agent-cli`; unknown **throws**), `DF_AGENT_CLI` (`gemini` | `claude` |
   `codex`), plus the config keys in the issue. Same fail-closed shape as R1's driver factory.
3. **T3 — governed model gateway** `app/api/llm-gateway/route.ts` (OpenAI-compatible):
   authenticate the sandbox with an opaque **lease**; call the EXISTING
   `runGovernedLlmCall()` from `agent/lib/dark-factory/governed-llm-call.ts` **verbatim** (reserve ->
   run -> settle) — do NOT re-implement reserve/settle beside it, or two implementations of one
   contract will drift; **refuse before forwarding** (4xx, zero upstream spend); model allow-list;
   stream upstream with the provider key **server-side**; settle + record usage/metrics per run;
   **forward `tenantId`** (never let sandbox spend fall silently to GLOBAL); **record the refusal on the
   run**. Reuse the auth/rewrite pattern in `app/api/eve/v1/[...slug]/route.ts`. Category stays the
   existing `developer` (no new category) capped by `DF_COST_BUDGET_DEVELOPER_USD`.
4. **T4 — live execution driver + egress.** Add the `opensandbox` arm to R1's
   `createSandboxProvider` (today it lands in the unknown-value branch and refuses), and apply egress
   policy: **allow the gateway host only, deny direct provider hosts** — a fail-closed backstop so a
   missing base URL cannot silently spend.
5. **T5 — `agent-cli` adapter + coordinator.** Run the configured CLI **inside** the sandbox via
   `commands.run`, with its base-URL knob pointed at the gateway and its key a lease; collect the git
   diff; run the Definition-of-Done checks in the coordinator. Lifecycle: **one sandbox per run**
   (not per iteration), destroyed on success, on throw AND on abort.
6. **T6 — docs and ADRs.** `docs/adr/0029-df-code-author-seam.md` and
   `docs/adr/0030-df-llm-gateway.md` (numbers taken from current main), linked from the ADR index;
   catalog rows; active `.env.example` rows (CI-guarded by design).

## Verification stance: mock-first, live-last

The model path is built against a **fixture gateway** — fully local and repeatable, like R1. The live
OpenRouter leg flips on behind the same seam once a key is provisioned; it is never the thing that
proves the plumbing. T0 is real from day one because it needs no key.

## Verification (local, then CI)

Full suite · `tsc --noEmit --incremental false` · `DF_PLATFORM_PROVIDER=generic npm run build` ·
**cspell over every changed file, AFTER committing** (a pre-commit diff silently excludes everything
unstaged — learned the hard way) · changed-markdown checks · the three repo guards
(`doc-drift-guards`, `adr-integrity`, `env-example-coverage`) · then a PR against `main` for CI.

## Risks / open questions

- **`destroy()` is mandatory** — closing the SDK client does NOT terminate the remote sandbox. An
  orphaned sandbox is a leak and spend, so cleanup on success/throw/abort has its own acceptance test.
- **`use_server_proxy`** decides whether traffic routes via the lifecycle server; needed when the client
  cannot reach container addresses. Per environment, never hardcoded.
- **Cold start** (image pull + `execd` injection) — argued for one long-lived sandbox per run.
- **Per-CLI base-URL fidelity** drifts between versions, and some CLIs make non-model calls that ignore
  the override. Keep it inside the adapter that names the exact knob; verify per CLI.
- **The gateway is a new critical path** — a run cannot author without it, so it needs its own auth and
  an availability story.
- **Operator gotcha to document:** `DF_COST_BUDGET_DRIVER` ARMS the gate. With no cap provisioned every
  model call is refused `not_configured`. Provision `DF_COST_BUDGET_DEVELOPER_USD` (and the global cap)
  **before** flipping `DF_CODE_AUTHOR`.
- **Control honesty:** a foreign CLI process cannot be interrupted mid-turn — pause/stop stay
  loop-boundary only. The sandbox can be killed, but it cannot be paused and resumed mid-turn. Say so plainly.

## Out of scope

Credential-vault secret injection (R3 #282). Until then the provider key stays gateway-side and the git
push token keeps its current mechanism.
