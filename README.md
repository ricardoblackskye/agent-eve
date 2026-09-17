# agent-eve

[![CI](https://github.com/ricardoblackskye/agent-eve/actions/workflows/ci.yml/badge.svg)](https://github.com/ricardoblackskye/agent-eve/actions/workflows/ci.yml)

An intelligent AI agent built with [Eve](https://eve.dev) — Vercel's framework for durable, production-grade AI agents in TypeScript.

## Prerequisites

- **Node.js 24+** — required by Eve. Install via [nvm](https://github.com/nvm-sh/nvm):
  ```bash
  nvm install 24
  nvm use 24
  ```
- **npm** — bundled with Node.js
- **OpenRouter API key** — for model access (or configure a different provider)

## Quick Start

```bash
# Install dependencies
npm install

# Set your API key
export OPENROUTER_API_KEY=sk-or-...

# Start the dev server
npm run dev
```

The agent listens at `http://localhost:3000`. Send a message:

```bash
curl http://localhost:3000/eve/v1/health
```

## Project Layout

```text
agent-eve/
├── agent/
│   ├── agent.ts            # Agent config (model, limits, context window)
│   ├── instructions.md     # System prompt / agent identity
│   ├── channels/
│   │   └── eve.ts          # HTTP channel configuration
│   ├── tools/              # Custom tools (add yours here)
│   ├── connections/        # MCP / OpenAPI service connections
│   └── skills/             # On-demand procedure packs
├── evals/
│   ├── evals.config.ts     # Eval runner configuration
│   ├── smoke.eval.ts       # Basic smoke test (3 gates)
│   └── ...                 # Add more evals here
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration

### Model Provider

The agent uses **OpenRouter** via `@ai-sdk/openai` with Chat Completions API routing:

```ts
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  name: "openrouter",
});
```

The default model is `deepseek/deepseek-v4.1-flash` with a 128k context window set explicitly for compaction support.

To switch models, edit `agent/agent.ts` or override the env var:

```ts
model: openrouter.chat(process.env.EVE_CHAT_MODEL ?? "deepseek/deepseek-v4.1-flash"), // OpenRouter model ID
```

### Model Performance & Quality Benchmarks

A model swap must not silently degrade latency or output quality. Two
skippable, live benchmark tests guard this (they run only when an
`OPENROUTER_API_KEY` is present; they skip in CI/offline so the suite never
flakes):

- **L1 — Latency** (`tests/model-latency.bench.contract.test.ts`): sends a
  fixed prompt to the configured model via OpenRouter streaming and asserts
  time-to-first-token + total latency stay within the committed budget in
  `tests/fixtures/model-baseline.json`.
- **L2 — Quality** (`tests/model-quality.regression.contract.test.ts`): sends a
  fixed graded prompt and asserts the output still meets capability gates
  (required story sections present, no refusal/error, not truncated).

The pure policy logic (`assertLatencyWithinBudget`, `gradeStoryQuality`) lives
in `tests/helpers/model-bench.ts` and is unit-tested offline in
`tests/model-bench-helpers.test.ts`.

**Re-baselining after a real measurement.** The fixture ships with
`latency.baselineMs: null`, so only the absolute **ceiling** (30s) is enforced
today. To capture a real baseline (so future swaps are compared against a
measured value, not just the ceiling):

```bash
# 1. Put your OpenRouter key in the environment (never commit it)
export OPENROUTER_API_KEY=sk-or-...        # or add to .env.local

# 2. Run the benchmarks recording the measured values
MODEL_BENCH_RECORD=1 npx vitest run \
  tests/model-latency.bench.contract.test.ts \
  tests/model-quality.regression.contract.test.ts
# → prints e.g. [model-latency] RECORD ttftMs=820 totalMs=4100
#   and        [model-quality] RECORD output: <the model's story>

# 3. Edit tests/fixtures/model-baseline.json and set
#      "latency": { "ceilingMs": 30000, "baselineMs": 4100, "tolerance": 1.5 }
#    (baselineMs = the recorded totalMs; tolerance lets a future model be up
#    to 50% slower before the test fails).
#    Keep the quality gate (minChars / requiredSections / refusalMarkers) as-is
#    unless the graded prompt or acceptance bar should change.

# 4. Commit the updated fixture (no secret is stored — only the measured number)
git add tests/fixtures/model-baseline.json
git commit -m "bench: re-baseline model latency (totalMs=4100)"
```

After this, a future model whose `totalMs` exceeds `baselineMs * tolerance`
(4100 × 1.5 = 6150 ms) will **fail** the latency test, catching a real
regression. Re-run the record step whenever you change models or the hosting
region/infra shifts the latency profile.

To force the live tests to skip (e.g. in a constrained CI slice) set
`MODEL_BENCH_OFFLINE=1`.

### Environment Variables

All variables are set as **Vercel environment variables** (Project Settings →
Environment Variables) in production, or in a local `.env.local` copied from
[`.env.example`](.env.example) for development. Variables marked **Secret** must
be flagged **Sensitive** in Vercel (masked, not readable via `vercel env pull`);
**Config** values are non-sensitive (e.g. allow-lists, board ids).

| Variable                    | Required | Type   | Description                                                                                                                               |
|-----------------------------|----------|--------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `OPENROUTER_API_KEY`        | Yes      | Secret | OpenRouter API key for model access                                                                                                       |
| `EVE_API_KEY`               | Yes      | Secret | Bearer token for production auth (sent as `Authorization: Bearer` header)                                                                 |
| `NEXT_PUBLIC_EVE_API_KEY`   | Yes*     | Public | Client-side chat-widget key sent to your own `/api/eve` proxy (inlined in the browser bundle — **public by design, never a real secret**) |
| `GH_RELEASE_TOKEN`          | Yes      | Secret | GitHub token the Release Manager uses to write `releasenotes.md` on merge (needs `Contents` + `Issues: write`)                            |
| `GH_STORY_TOKEN`            | Yes*     | Secret | Token the Product Owner uses to create `[Story]` issues (needs `Issues: read and write`); read before `GH_RELEASE_TOKEN`                  |
| `GITHUB_TOKEN`              | No       | Secret | Final fallback token if neither `GH_RELEASE_TOKEN` nor `GH_STORY_TOKEN` is set                                                            |
| `GH_WEBHOOK_SECRET`         | Yes      | Secret | Shared secret that authenticates incoming webhook payloads (required on Vercel; see Webhooks)                                             |
| `GH_SPRINT_TOKEN`           | No*      | Secret | Token for reading the Projects V2 board (`read:project` scope); falls back to `GH_RELEASE_TOKEN`                                          |
| `VERCEL_PROTECTION_BYPASS`  | No       | Secret | Bypass secret for Vercel Protection (password/SSO) so server-to-server calls reach the app                                                |
| `EVE_CHAT_MODEL`            | No       | Config | Override the root chat model id (default `deepseek/deepseek-v4.1-flash`)                                                                  |
| `MODEL_NAME`                | No       | Config | Model id for subagents (Sprint Metrics Analyst, PR-reviewer Action); default `deepseek/deepseek-v4.1-flash`                               |
| `EVE_STORY_MENTION`         | No       | Config | Mention that triggers the Product Owner in an issue body (default `@eve-agent`)                                                           |
| `EVE_STORY_LABEL`           | No       | Config | Label that triggers the Product Owner (default `needs-story`)                                                                             |
| `STORY_ALLOWED_REPOS`       | Yes      | Config | **Fail-closed** comma-separated `owner/repo` allow-list for story publishing; refusing if unset                                           |
| `GITHUB_REPO_OWNER`         | No       | Config | Optional env override for the default publish owner                                                                                       |
| `GITHUB_REPO_NAME`          | No       | Config | Optional env override for the default publish repo                                                                                        |
| `SPRINT_PROJECT_OWNER`      | No       | Config | Projects V2 board owner for sprint reports (default `ricardoblackskye`)                                                                   |
| `SPRINT_PROJECT_NUMBER`     | No       | Config | Projects V2 board number for sprint reports (default `3`)                                                                                 |
| `PR_REVIEW_MAX_DIFF_CHARS`  | No       | Config | Cap on diff chars sent to the PR-reviewer LLM (default `20000`)                                                                           |
| `DF_STATE_DRIVER`           | No       | Config | Dark Factory execution-memory store: `sqlite` = file-backed adapter; unset = fail-closed refusing default                                 |
| `DF_STATE_DB_PATH`          | No*      | Config | Required when `DF_STATE_DRIVER=sqlite` — path to the SQLite file (ephemeral on Vercel)                                                    |
| `DF_STATE_DB_DIR`           | No       | Config | Optional sandbox root: when set, `DF_STATE_DB_PATH` must resolve inside it or boot refuses                                                |
| `DF_DISPATCH_MAX_RETRIES`   | No       | Config | Retry budget for a failed worker dispatch (default `2`)                                                                                   |
| `DF_DISPATCH_BASE_DELAY_MS` | No       | Config | Base backoff delay in ms, multiplied per retry (default `1000`)                                                                           |
| `DF_METRICS_DRIVER`         | No       | Config | Dark Factory observability store; unset or `memory` = in-process (default)                                                                |
| `DF_WORKER_PROVIDER`        | No       | Config | Where a worker sandbox runs; unset/`local` = dry-run provider that reports `isolated: false`                                              |
| `DF_WORKER_ALLOWED_REPOS`   | No*      | Config | **Fail-closed** comma-separated `owner/repo` allow-list for worker tasks; unset = every task refused with 403 before provisioning         |
| `DF_WORKER_RUNTIME`         | No       | Config | Runtime requested in the worker environment: `node` or `python` (default `node`)                                                          |
| `DF_CREDENTIAL_TTL_SECONDS` | No       | Config | Per-task credential lease lifetime, 1..3600 (default `3600`); the sandbox gets a lease, never the token                                   |

\* `NEXT_PUBLIC_EVE_API_KEY` and `GH_STORY_TOKEN` are required for the chat
widget and story generation respectively; `GH_SPRINT_TOKEN` is only needed for
the sprint-metrics report. `GH_RELEASE_TOKEN` alone covers releases.

> **Provisioning rule:** after adding or changing ANY environment variable on
> Vercel, you must **redeploy** — changes do not apply to existing deployments.

### Dark Factory (R1)

The Dark Factory turns Eve from a stateless prompt-responder into an
orchestrator with durable execution memory. R1 ships the three foundation seams
under `agent/lib/dark-factory/` — no containers and no worker agents yet (those
are R2/R3):

- **`state.ts` (#134)** — `StateStore` seam for execution memory (current issue,
  assigned worker, last test outcome, delivery-loop step). Ships a file-backed
  `node:sqlite` adapter and a `console` default that **refuses** to claim a write
  it did not persist.
- **`dispatch.ts` (#138)** — canonical CI-event payload, at-most-once dispatch
  (dedup keyed on the run id, persisted so it survives a restart), bounded
  exponential-backoff retry with a terminal `failed` status, and worker routing.
- **`metrics.ts` (#140)** — `TaskMetric` ingestion any component can feed,
  exact test-fail→fix cycle counts, success rate per task type, and a buffered
  recorder that retains and retries records the backend rejected ("must not lose
  records").
- **`index.ts`** — env-driven factories and the `dispatch → metrics` observer.

`DF_STATE_DRIVER` is **fail-closed**: leaving it unset yields the refusing
default rather than an in-process store that would silently lose state on the
next request. A file-backed store is enough to prove real external-state
semantics locally and in CI, but a Vercel function filesystem is ephemeral — so
production persistence needs a Redis/pgvector adapter in a later release. See
[`ARCHITECTURE.md`](ARCHITECTURE.md#dark-factory-r1) for the seam design.

### Dark Factory (R3) — Circuit Breaker / Cost Guard (#144)

Starting in R3, a **circuit breaker** caps how much a single PBI may cost before a
human is pulled in. It is independent of, and additive to, the per-task retry bounds
in #138/#143.

- **`circuit-breaker.ts` (#144)** — a `CircuitBreaker` stateful guard that tracks,
  per `pbiId`, **cumulative worker-minutes** and **failed self-correct cycles**:
  - `DF_MAX_WORKER_MINUTES_PER_PBI` (default 60) — total worker-task duration crosses threshold, or
  - `DF_MAX_FAILED_SELFCORRECT` (default 3) — N CI-fail → re-dispatch → fail cycles with no success.
- A tripped PBI stays **halted**: no further minutes counted, no additional trips emitted.
- **Wiring** — `createCircuitBreaker(env)` builds from env knobs (fail-closed on bad values);
  `createWorkerActivityObserver(breaker)` adapts it into the worker-env sink.
- See [`ARCHITECTURE.md`](ARCHITECTURE.md#factory-level-circuit-breaker-cost-guard-r3-144) for detail.

### Dark Factory (R3) — Developer Agent (#133)

The **Developer Agent** is an autonomous agent that accepts a task description, writes code in a sandboxed worker, modifies files guided by a skeletal map, writes unit tests, and iterates the TDD cycle until tests pass.

- **`developer-agent.ts` (#133)** — the Developer Agent seam with:
  - `toTaskAssignment()` — validates and builds the task payload
  - `runCodingLoop()` — drives the fail→fix→pass TDD cycle
  - `applySkeletalMap()` — writes skeleton files into a workspace (fails closed on path traversal)
  - `assertToolAllowed()` — enforces the allowed-tools allowlist
  - `recordIteration()` — emits metrics via `MetricsStore`

- **Tool confinement (AC4):** only `git_clone`, `read_file`, `write_code`, `run_tests` are permitted. Any other tool invocation throws `ToolNotAllowedError`.

- **Configuration:** `DF_MAX_ITERATIONS` (default 10) caps loop iterations; `DF_MAX_WORKER_MINUTES_PER_TASK` (default 15) is a complexity heuristic.

### Dark Factory (R4a) — Self-Improvement Controller (#146)

The Dark Factory's within-task self-correction loop (#138) fixes the defect in
front of it; it does not improve **over time**. R4a adds the controller that
closes that gap, in `agent/lib/dark-factory/self-improve.ts`:

OBSERVE → PROPOSE → APPLY → MEASURE → DECIDE → RECORD

- **OBSERVE** reads the aggregate metrics straight from the #140 store
  (`MetricsStore.getRecords()`) — there is deliberately no parallel metric store.
- **PROPOSE** produces a candidate change against a `TunableSurface` (R4a ships
  `IterationBoundSurface`, wrapping the `DF_MAX_ITERATIONS` knob) together with
  an explicit written hypothesis.
- **APPLY** stages the change behind a versioned, reversible `VersionHandle`
  (`iteration-bound@v2`) — never in place.
- **MEASURE** re-runs a fixed benchmark
  (`tests/fixtures/self-improve-benchmark.json`) through the same pure quality
  gate the #121 model benchmarks use, so the numbers are deterministic and need
  no API key. The loader (`loadImprovementBenchmark`) validates the fixture's
  version, gate shape and every case, and accepts an optional `sandboxRoot` so a
  deployment that makes the path settable can bound where it may be read.
- **DECIDE** accepts **only** if the objective metric (success rate per task
  type) improves by at least `DF_SELFIMPROVE_OBJECTIVE_TOLERANCE` and no
  guardrail (mean iterations / mean fix cycles) regresses beyond
  `DF_SELFIMPROVE_GUARDRAIL_TOLERANCE`.
- **RECORD** appends an immutable ledger entry: what changed, why, the
  baseline → after numbers, and the verdict.

Fail-closed by design: a measurement that fails or is non-finite **rejects and
reverts** rather than accepting on faith; an `access-widening` proposal with no
operator gate is **blocked**; a tripped #144 cost guard short-circuits the cycle
before any work happens; and an unset `DF_SELFIMPROVE_ENABLED` makes the
controller inert.

Run a cycle locally (prints the real before → after trace):

```bash
npx vitest run tests/dark-factory/self-improve.test.ts --reporter=verbose
npx vitest run tests/dark-factory/self-improve.test.ts -t "DEMO" --reporter=verbose
```

### Dark Factory (R4b) — Recurrence, Trend and Operator Override (#146)

R4a runs **one** cycle. R4b makes the loop recur and makes its effect provable.

**Cadence is a decision, not a timer.** A Vercel serverless function cannot host
a long-lived loop (#127), so an in-process `setInterval` would pass locally and
silently never fire in production. Instead `isCycleDue({ lastRunAt, now,
intervalMinutes })` answers "should a cycle run now?" from a persisted
watermark, and the caller's scheduler (Vercel Cron, a GitHub Action, an
operator) calls `runScheduledCycle`. The watermark advances only once a cycle has
completed — whatever its verdict — so a scheduler firing early cannot busy-loop
the factory.

**Trend (AC6).** `objectiveTrend(ledger.entries())` reports the measured
objective per cycle plus `first`, `last`, `delta` and accepted/rejected counts,
so a single accepted step cannot masquerade as cumulative improvement. Filter to
one surface with `{ surfaceId }`.

**Operator override.** An out-of-band human cannot answer mid-request, so the
gate is *pre-armed* rather than awaited: `createOperatorDecisionStore(store)`
records an allow/deny for a (surface, kind) pair with an optional expiry, and
`operatorGateFromStore()` supplies the `OperatorGate` that R4a consumes.
Fail-closed throughout — nothing recorded, expired, unreadable expiry, or an
explicit deny all refuse.

Durability reuses the existing `StateStore` seam (#134): the watermark and the
decisions live in the configured state store, and no new storage is introduced.

```bash
npx vitest run tests/dark-factory/self-improve-cadence.test.ts \
               tests/dark-factory/self-improve-operator.test.ts --reporter=verbose
```

### User Story Generation

Label an issue `needs-story` (or mention `@eve-agent` in the body) and the
Product Owner subagent drafts a structured `[Story]` issue. On a successful
publish, the agent:

- creates a new `[Story]` issue whose body links back to the source issue, and
  posts a cross-reference comment on the source issue (the parent → child link);
- removes the `needs-story` label from the source issue; and
- applies the `user-story-added` label to the source issue.

`user-story-added` does **not** re-trigger generation, so a publish completes
without looping.

### Sprint Metrics Report

Label an issue `generate-sprint-report` and the Sprint Metrics Analyst subagent
reads the GitHub Kanban board (Projects V2) and generates a report with cycle
time, throughput, and work-in-progress. It writes the report into `reports/` as
Markdown and PDF, and posts a linking comment on the issue. Requires a token with
`read:project` scope (`GH_SPRINT_TOKEN`); the board defaults to user project
`ricardoblackskye` #3, overridable via `SPRINT_PROJECT_OWNER` /
`SPRINT_PROJECT_NUMBER`.

## Scripts

| Command             | Description                            |
|---------------------|----------------------------------------|
| `npm run build`     | Build the agent (`eve build`)          |
| `npm run dev`       | Start the development server           |
| `npm run start`     | Start the production server            |
| `npm run typecheck` | TypeScript type-check (`tsc --noEmit`) |
| `eve eval`          | Run all evals against running server   |

## Testing (Evals)

Eve provides a built-in eval framework. Evals live in `evals/` and run against a live dev server:

```bash
# Run all evals locally (auto-boots dev server)
eve eval

# Run against a deployed URL
EVE_EVAL_AUTH_TOKEN=<your-token> eve eval --url https://agent-eve-gold.vercel.app

# Single eval with detail
eve eval smoke --verbose
```

### Current Evals

| Eval           | Gates | Description                                |
|----------------|-------|--------------------------------------------|
| `smoke`        | 2/2   | Agent boots and responds                   |
| `auth-valid`   | 2/2   | Authenticated requests succeed             |
| `auth-invalid` | 1/1   | Unauthenticated requests rejected with 401 |

### CI Pipeline

Every PR triggers a GitHub Actions workflow with three checks:

| Check          | What it does                                                    |
|----------------|-----------------------------------------------------------------|
| **TypeScript** | `tsc --noEmit` — type safety verification                       |
| **Eve Build**  | `eve build` — verifies the agent compiles                       |
| **Eve Evals**  | `eve eval --strict` — runs all evals against a local dev server |

On push to `main`, an additional **Production Evals** job runs all evals against the live deployment.

The workflow requires these GitHub Action secrets:

- `OPENROUTER_API_KEY` — for CI evals against the local dev server
- `EVE_EVAL_AUTH_TOKEN` — for production evals (same value as `EVE_API_KEY`)

## Deployment

### Vercel Deployment Settings

1. Link the project:

   ```bash
   vercel link    # or: eve link --project agent-eve --non-interactive
   ```

2. In the Vercel dashboard (**Project Settings → Environment Variables**), add
   every **Secret** variable from the [Environment Variables](#environment-variables)
   table. For each token tick **Sensitive** so it is masked and cannot be read
   back with `vercel env pull`. The **Config** variables (allow-lists, board ids,
   model overrides) are plain text — they are not credentials.

   At minimum for a working deploy you need:
   `OPENROUTER_API_KEY`, `EVE_API_KEY`, `NEXT_PUBLIC_EVE_API_KEY`,
   `GH_RELEASE_TOKEN`, `GH_STORY_TOKEN`, `GH_WEBHOOK_SECRET`, and
   `STORY_ALLOWED_REPOS`.

3. Deploy:

   ```bash
   eve deploy --project agent-eve --non-interactive --yes
   ```

The `eve deploy` command handles building, bundling, and deploying with Vercel
Workflow, Sandbox, and Cron integrations.

> **Redeploy rule:** after adding or changing ANY environment variable, you must
> **redeploy** — values do not apply to existing deployments.

### Git Configuration Steps

- **Clone & branch protection:** the repo enforces a GitHub **branch ruleset** on
  `main` (required status check *Unit Tests*, non-fast-forward merges). Do not
  push directly to `main`; open a PR from a feature branch and let CI merge it.
- **Enabling a new repo for webhooks / release notes:** the mapping from repo →
  webhook-secret-env + release-notes path lives in
  [`release-manager.config.json`](release-manager.config.json). Add an entry
  there to let the agent process that repo's events.
- **Allowing story publishing to a repo:** the agent only writes `[Story]` issues
  to repos listed in `STORY_ALLOWED_REPOS` (a **fail-closed** allow-list — unset
  means *refuse everything*). Add every repo the agent should be able to publish
  to, comma-separated:
  `STORY_ALLOWED_REPOS=ricardoblackskye/agent-eve,ricardoblackskye/WebFeedPOC`.
- **Local development:** copy [`.env.example`](.env.example) to `.env.local` and
  fill in values. `.env.local` is git-ignored; only `.env.example` is committed.

### Webhook Setup

The agent reacts to GitHub events through a webhook that Vercel hosts at:

```text
https://<your-deployment>.vercel.app/api/github/webhook
```

Configure it once in the repo (**Settings → Webhooks → Add webhook**):

| Field            | Value                                                     |
|------------------|-----------------------------------------------------------|
| **Payload URL**  | `https://<your-deployment>.vercel.app/api/github/webhook` |
| **Content type** | `application/json`                                        |
| **Secret**       | the value of `GH_WEBHOOK_SECRET`                          |
| **Events**       | **Pull request** (subscribe to Pull request events)       |

The webhook verifies `GH_WEBHOOK_SECRET` on every request
(`app/api/github/webhook/route.ts` reads it from
`process.env[repoConfig.webhook_secret_env]`), so the secret must match the
`GH_WEBHOOK_SECRET` set in your Vercel environment variables. If it is unset in a
deployed environment the handler returns HTTP 500 rather than processing an
unverified payload.

Two issue **labels** drive subagents (apply them in the source repo):

- `needs-story` → the Product Owner drafts a `[Story]` issue in that repo
  (gated by `STORY_ALLOWED_REPOS`).
- `generate-sprint-report` → the Sprint Metrics Analyst reads the Projects V2
  board and posts a report (token: `GH_SPRINT_TOKEN`, scope `read:project`).

> The webhook must be created in GitHub repo Settings for the flow to run — this
> documents how; it does not create the webhook for you.

### Secrets / Tokens Management

All credentials are **environment variables**, never hard-coded. In production
they live only in Vercel (Sensitive, masked); locally in `.env.local` (git-ignored).

| Variable                   | Kind   | Where it lives                                    | Scope needed                                                                                    |
|----------------------------|--------|---------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `OPENROUTER_API_KEY`       | Secret | Vercel (Sensitive) / `.env.local`                 | OpenRouter API access                                                                           |
| `EVE_API_KEY`              | Secret | Vercel (Sensitive) / `.env.local`                 | Production auth bearer token                                                                    |
| `NEXT_PUBLIC_EVE_API_KEY`  | Public | Vercel (plain — **not** Sensitive) / `.env.local` | Chat-widget key for your own `/api/eve` proxy; inlined in the browser bundle (public by design) |
| `GH_RELEASE_TOKEN`         | Secret | Vercel (Sensitive) / `.env.local` / Actions       | `Contents: write` **+** `Issues: write` (or `public_repo` / `repo`)                             |
| `GH_STORY_TOKEN`           | Secret | Vercel (Sensitive) / `.env.local` / Actions       | `Issues: read and write` (read before `GH_RELEASE_TOKEN`)                                       |
| `GITHUB_TOKEN`             | Secret | Vercel / Actions (fallback)                       | Same as above                                                                                   |
| `GH_WEBHOOK_SECRET`        | Secret | Vercel (Sensitive) + GitHub webhook config        | Webhook payload verification                                                                    |
| `GH_SPRINT_TOKEN`          | Secret | Vercel (Sensitive) / Actions                      | `read:project` (Projects V2 board read)                                                         |
| `VERCEL_PROTECTION_BYPASS` | Secret | Vercel (Sensitive)                                | Bypass Vercel Protection for server-to-server calls                                             |

**Rules:**

- Mark every **Secret** row **Sensitive** in Vercel. Config rows (`STORY_ALLOWED_REPOS`,
  `EVE_CHAT_MODEL`, `MODEL_NAME`, `SPRINT_PROJECT_*`, `EVE_STORY_*`, `PR_REVIEW_MAX_DIFF_CHARS`,
  `GITHUB_REPO_*`) are plain text.
- `GH_RELEASE_TOKEN` needs **Issues: Read and write** in addition to Contents — a
  Contents-only token returns `403` on story/comment calls. On a classic PAT, tick
  `public_repo` (or `repo` for private repos).
- Never commit real values. `.env.example` holds only placeholder lines and
  descriptions; `.gitignore` excludes every other `.env*`.
- After any change, **redeploy** (see [Vercel Deployment Settings](#vercel-deployment-settings)).

Repo → webhook-secret + release-notes-path mapping lives in
[`release-manager.config.json`](release-manager.config.json). Add a new repo
there to enable webhook processing for it.

**What happens:**

- Opening or editing a PR triggers the **PR-reviewer** GitHub Action, which posts
  an AI code review (model set by the `MODEL_NAME` repo variable — defaults to
  `deepseek/deepseek-v4.1-flash`).
- Merging a PR fires the webhook → the **Release Manager** subagent updates
  [`releasenotes.md`](releasenotes.md) with a summary of the change.

### Self-Hosted / Docker

```bash
npm run build
npm run start
```

## Adding Tools

Create a TypeScript file in `agent/tools/`:

```ts
// agent/tools/get_weather.ts
import { defineTool } from "eve/tools";

export default defineTool({
  description: "Get the current weather for a city",
  parameters: {
    city: { type: "string", description: "City name" },
  },
  async execute({ city }) {
    const res = await fetch(
      `https://api.weather.com/current?city=${encodeURIComponent(city)}`,
    );
    return res.json();
  },
});
```

Eve auto-discovers tools by their file path — no registration needed.

## Resources

- [Eve Documentation](https://eve.dev/docs)
- [Eve Getting Started](https://eve.dev/docs/getting-started)
- [Eve Agent Config](https://eve.dev/docs/agent-config)
- [AI SDK Docs](https://sdk.vercel.ai)
- [OpenRouter](https://openrouter.ai)

## License

MIT# Last rebuilt: 2026-08-24T17:35:32Z
