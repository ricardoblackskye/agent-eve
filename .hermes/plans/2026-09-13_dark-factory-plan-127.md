# Dark Factory — High-Level Initiative Plan

> **For Hermes:** This is a portfolio-level (epic) plan. Each release below is a separate deliverable to be split into its own branch and implementation plan when its planning phase begins. Do not implement all releases at once.
>
> **Parent:** [#127 Dark Factory (Portfolio Epic)](https://github.com/ricardoblackskye/agent-eve/issues/127)
> **Spine:** [#128 Dark Factory Plan — Overview](https://github.com/ricardoblackskye/agent-eve/issues/128)
> **Plan branch:** `docs/dark-factory-plan-127` — this file
> **Date:** 2026-09-13

**Goal:** Evolve Eve from a passive, stateless copilot into an **agentic orchestrator** of a "dark factory" — an automated, unsupervised software-delivery loop where specialized Worker Agents (Developer, Tester) operate in sandboxed containers, supervised by Eve as dispatcher and quality gate, with durable state, an async event queue, and a self-correction loop on CI failure.

**Architecture (from #127/#128):**
- **Eve (Orchestrator)** lives on Vercel. It plans/validates and routes work; it is *not* the executor of long-running coding/test loops (Vercel function timeouts preclude that).
- **Worker Agents** (Developer `#131`, Tester `#132`) run in short-lived **containerized sandboxes** (Component B `#130`), writing/validating code against a pushed "skeletal file map + PBI data."
- **Asynchronous dispatch** via **Upstash QStash** so Eve never blocks on a long job — she pushes to a queue and acts as quality gate on the result (Orchestration Core `#137`).
- **State & Memory** (Component A `#129`) persists the active issue, assigned worker, last test run outcome, and loop step so the factory resumes deterministically between requests.
- **Self-correction loop:** central CI failure → event → eve intercepts/interpret → routes back to a worker sandbox to fix → re-validated, all without human intervention.
- **Recursive self-improvement (Observability `#139`):** every component emits metrics (iteration counts, test-fail→fix cycles, success rate per task type) so the factory measurably improves over time. DRY by design.

**Tech stack (current):** Next.js + Eve framework on Vercel, OpenRouter (DeepSeek V4.1 Flash), GitHub REST API via `~/.git-credentials` PAT, existing subagents (product-owner, pr-reviewer, release-manager, sprint-reporter), provider-agnostic seam pattern (`backlog-provider` — canonical payload + adapters). New: state store (Sqlite/Redis/pgvector), container provider (E2B/Modal), Upstash QStash queue.

---

## Issue map (all parented under #128)

| Epic | Item | Story | Parent |
|---|---|---|---|
| #128 Plan Overview | Portfolio Epic | — | → #127 |
| #129 Component A — Stateful Execution Memory | Epic | #134 | → #128 |
| #130 Component B — Containerized Compute (Worker Environment) | Epic | #135 | → #128 |
| #131 Developer Agent (Eve's Team) | Epic | #133 | → #128 |
| #132 Tester Agent (Eve's Team) | Epic | #136 | → #128 |
| #137 Orchestration Core (Messaging/Dispatch/Self-Correction) | Epic | #138 | → #128 |
| #139 Observability (Self-Improvement) | Epic | #140 | → #128 |
| #141 Credential ingress / worker privilege boundary | Task | #142 | → parent #128 (via Component B context) |
| #143 Factory-level circuit breaker / cost guard | Feature | #144 | → parent #128 |

---

## Delivery order (release split)

This is a multi-phase epic. Work is deliberately split into **three releases** so each is shippable on its own and no single branch/PR balloons. **Only R1 is planned in detail; R2/R3 are scoped here and planned when reached.**

Each release maps to the issue labels the operator will apply (suggested label values below).

### R1 — `feat/df-core` (Foundation: state + dispatch + metrics)
> Label suggestion: **`release:R1`**

Delivers the orchestration spine with **no real containers** — a local stub worker stands in. This unblocks everything else and is the riskiest-resolved layer (state durability, queue idempotency).

- **#134 / #129 — Component A: Stateful Execution Memory** — persist issue, worker, last-test outcome, loop step in an external store (Sqlite → pluggable to Redis/pgvector) via the canonical-payload + provider seam.
- **#138 / #137 — Orchestration Core** — ingest CI-failure events, dedup/idempotency, bounded retry + backoff, worker dispatch lifecycle, terminal-failure status. Depends on #134 (persist dispatch state across restarts).
- **#140 / #139 — Observability (ingestion)** — metric schema + ingestion interface; every component MAY start emitting. Zero-work path to capture iteration/fix-cycle/success-rate once workers exist.

**Explicit non-goals in R1:** no container provisioning, no worker agents, no GitHub token delivery.

### R2 — `feat/df-worker-env` (Real hands: containers + credentials)
> Label suggestion: **`release:R2`**

- **#135 / #130 — Component B: Containerized Compute** — one container provider (E2B first) behind an adapter (provider-agnostic seam, matching the `backlog-provider` pattern). Push skeletal map + PBI into sandbox; provision Git + runtime; teardown on completion. Provider swappable (Modal/others).
- **#142 / #141 — Credential ingress / worker privilege boundary** — short-lived, repo-allowlisted credential (fine-grained GH App token preferred), TTL ≤ 60 min, revoked on task end/expiry, NO broad PAT ever delivered to a sandbox. **Fail-closed allow-list** (deny when unconfigured). (See #135 AC reference & #142 constraint `Relates to #135`.)

### R3 — `feat/df-team` (The factory runs: team + self-correction + guardrails)
> Label suggestion: **`release:R3`**

- **#133 / #131 — Developer Agent ("The Doer")** — `git_clone, read_file, write_code, run_tests`; guided by skeletal map; writes accompanying unit tests; iterates until tests pass (bounded iterations) inside the sandbox.
- **#136 / #132 — Tester Agent ("The Guard")** — `run_static_analysis, execute_smoke_tests, run_security_scan` before PR submission; blocks PR on quality/security regression.
- **PR Review Agent** — Eve's existing review (her current role) applied to her own Developer Agent's output, with full requirement context to prevent hallucination.
- **#144 / #143 — Factory-level circuit breaker / cost guard** — cap cumulative worker-minutes per PBI; halt + emit trip event; escalate to a human after N failed self-correct cycles (default 3); independent of and additive to per-task #138/#133 bounds; operator override. Rides on #138's terminal-failure escalation.

---

## Architectural principles (apply across all releases)

- **Provider-agnostic seams everywhere:** canonical payload + adapter interface for state stores (Sqlite/Redis/pgvector), container providers (E2B/Modal/Vercel-option), and dispatch (QStash vs local stub). Ship a `console`/dry-run/stub target in R1 so nothing blocks on real credentials.
- **Fail-closed security:** allow-list default = deny when unconfigured; sanitizer at the shared intake seam (owner/repo, names) before values enter canonical payloads; credentials least-privilege + short-lived + audited; never persisted in logs.
- **DRY by design:** reuse the existing `backlog-provider` canonical-payload pattern, subagent conventions, and story/code-review pipeline rather than new bespoke wiring.
- **Deterministic state:** the loop's position, assignment, and last outcome are facts in Component A, not inferred from context windows.
- **Measurability:** every component feeds Observability `#140`; improvement is gated on metrics, not intuition.

---

## Files likely to change

**Repository: `ricardoblackskye/agent-eve`**
- `agent/lib/*` — new modules: state store provider + adapters (#134), dispatch/queue service (#138), metrics ingestion (#140), container-provider adapters (#135), credential minting/revocation (#142), circuit-breaker guard (#144).
- `agent/subagents/*` — new `developer-agent` (#133), `tester-agent` (#136); existing `pr-reviewer` re-scoped for factory output review.
- `agent/instructions.md` / `agent.ts` — orchestrator role/model onboarding.
- `app/api/*` — webhook/route surface for CI-failure event ingestion and QStash subscribe callbacks.
- `.env.example` / `README` / `ARCHITECTURE.md` — env vars (state store URL, container API key, QStash token), architecture diagram updates.
- Tests: `tests/*` following repo Vitest convention.

> Note: env vars for external services (state store, E2B/Modal, QStash) are out-of-code-scope prerequisites the operator provisions (Vercel + GitHub Actions secrets); plan/adapter work must default to a stub/console provider so PRs stay non-destructive before credentials exist.

---

## Validation

- **Per release / story:** strict TDD (RED→GREEN→REFACTOR); full suite (`npm test`/Vitest) no regressions; `tsc --noEmit` clean; local lint gate (MegaLinter/cspell/standard) green on changed files incl. dotfiles & plan docs before any push.
- **R1:** crash-restart test proves state survives across requests; duplicate-event test proves dedup; a stub worker round-trips through the queue.
- **R2:** container provisions + receives pushed context + tears down; sandbox cannot reach outside its allow-listed repo; credential revoked on completion (401 after).
- **R3:** a planted test failure in a worker triggers the self-correct loop and a fix without human action; circuit breaker halts a runaway PBI and escalates.

---

## Risks / open questions

1. **Provider credential availability** — E2B/Modal/Upstash accounts & keys must exist (or be stubbed) before R2/R3. Confirm before planning R2 in detail.
2. **State store choice** — Sqlite (local dev) vs Redis/pgvector (prod on Vercel). The seam must keep the choice pluggable; decide prod target before R1 implementation to pin NFRs (#134 p95 <100ms read/write, <50ms retrieval).
3. **Vercel function runtime** — Durable dispatch must survive cold starts; QStash callback + persistent store is the mitigation. Validate event loss is zero with the chosen queue.
4. **Token/App provisioning for #142** — a GitHub App or narrowly-scoped token infra is needed to mint per-task credentials. The `~/.git-credentials` PAT (limited scope) can create issues/PRs but **cannot** write Actions secrets and is **not** suitable for worker provisioning. Scope/ownership of worker-credential infra is an R2 planning prerequisite.
5. **Label taxonomy** — the operator applies `release:R1/R2/R3` labels to the epic/story issues per the mapping above; board grouping depends on consistent application.
6. **Circuit-breaker default thresholds** — `max_worker_minutes` and `max_failed_selfcorrect_cycles (default 3)` need operator-visible config and sane defaults; #144 already scopes this.