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

```
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

The default model is `gpt-4o` with a 128k context window set explicitly for compaction support.

To switch models, edit `agent/agent.ts`:

```ts
model: openrouter.chat("anthropic/claude-sonnet-5"), // OpenRouter model ID
```

### Environment Variables

| Variable             | Required | Description                                                                             |
| -------------------- | -------- | --------------------------------------------------------------------------------------- |
| `OPENROUTER_API_KEY` | Yes      | OpenRouter API key for model access                                                     |
| `EVE_API_KEY`        | Yes      | Bearer token for production auth (sent as `Authorization: Bearer <EVE_API_KEY>` header) |

## Scripts

| Command             | Description                            |
| ------------------- | -------------------------------------- |
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
| -------------- | ----- | ------------------------------------------ |
| `smoke`        | 2/2   | Agent boots and responds                   |
| `auth-valid`   | 2/2   | Authenticated requests succeed             |
| `auth-invalid` | 1/1   | Unauthenticated requests rejected with 401 |

### CI Pipeline

Every PR triggers a GitHub Actions workflow with three checks:

| Check          | What it does                                                    |
| -------------- | --------------------------------------------------------------- |
| **TypeScript** | `tsc --noEmit` — type safety verification                       |
| **Eve Build**  | `eve build` — verifies the agent compiles                       |
| **Eve Evals**  | `eve eval --strict` — runs all evals against a local dev server |

On push to `main`, an additional **Production Evals** job runs all evals against the live deployment.

The workflow requires these GitHub Action secrets:

- `OPENROUTER_API_KEY` — for CI evals against the local dev server
- `EVE_EVAL_AUTH_TOKEN` — for production evals (same value as `EVE_API_KEY`)

## Deployment

### Vercel

1. Link the project:

   ```bash
   vercel link    # or: eve link --project agent-eve --non-interactive
   ```

2. Set environment variables in the Vercel dashboard:
   - `OPENROUTER_API_KEY`

3. Deploy:
   ```bash
   eve deploy --project agent-eve --non-interactive --yes
   ```

The `eve deploy` command handles building, bundling, and deploying with Vercel Workflow, Sandbox, and Cron integrations.

### GitHub Webhook (PR Code Review & Release Notes)

The agent reacts to GitHub Pull Request events through a webhook that Vercel
hosts at:

```
https://<your-deployment>.vercel.app/api/github/webhook
```

Configure it once in the repo (**Settings → Webhooks → Add webhook**):

| Field | Value |
| ----- | ----- |
| **Payload URL** | `https://<your-deployment>.vercel.app/api/github/webhook` |
| **Content type** | `application/json` |
| **Secret** | the value of `GH_WEBHOOK_SECRET` |
| **Events** | **Pull request** (subscribe to Pull request events) |

The webhook verifies the `GH_WEBHOOK_SECRET` on every request
(`app/api/github/webhook/route.ts` reads it from
`process.env[repoConfig.webhook_secret_env]`), so the secret must match the
`GH_WEBHOOK_SECRET` set in your Vercel environment variables.

Required environment variables (Vercel + GitHub Actions secrets):

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `GH_WEBHOOK_SECRET` | Yes | Shared secret that authenticates incoming webhook payloads. |
| `GH_RELEASE_TOKEN` | Yes | GitHub token the Release Manager uses to write `releasenotes.md` on merge. |
| `OPENROUTER_API_KEY` | Yes | Powers the AI review + release-notes generation. |

Repo → webhook-secret + release-notes-path mapping lives in
[`release-manager.config.json`](release-manager.config.json). Add a new repo
there to enable webhook processing for it.

**What happens:**

- Opening or editing a PR triggers the **PR-reviewer** GitHub Action, which posts
  an AI code review (model set by the `MODEL_NAME` repo variable — defaults to
  `deepseek/deepseek-v4-pro`).
- Merging a PR fires the webhook → the **Release Manager** subagent updates
  [`releasenotes.md`](releasenotes.md) with a summary of the change.

> The webhook must be created in GitHub repo Settings for the flow to run — this
> documents how; it does not create the webhook for you.

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
