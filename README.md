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

| Variable               | Required | Description |
|------------------------|----------|-------------|
| `OPENROUTER_API_KEY`   | Yes      | OpenRouter API key for model access |
| `EVE_API_KEY`          | Yes      | Bearer token for production auth (sent as `Authorization: Bearer <EVE_API_KEY>` header) |

## Scripts

| Command              | Description                           |
|----------------------|---------------------------------------|
| `npm run build`      | Build the agent (`eve build`)         |
| `npm run dev`        | Start the development server          |
| `npm run start`      | Start the production server           |
| `npm run typecheck`  | TypeScript type-check (`tsc --noEmit`)|
| `eve eval`           | Run all evals against running server  |

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
| Eval | Gates | Description |
|------|-------|-------------|
| `smoke` | 2/2 | Agent boots and responds |
| `auth-valid` | 2/2 | Authenticated requests succeed |
| `auth-invalid` | 1/1 | Unauthenticated requests rejected with 401 |

### CI Pipeline

Every PR triggers a GitHub Actions workflow with three checks:

| Check | What it does |
|-------|-------------|
| **TypeScript** | `tsc --noEmit` — type safety verification |
| **Eve Build** | `eve build` — verifies the agent compiles |
| **Eve Evals** | `eve eval --strict` — runs all evals against a local dev server |

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
      `https://api.weather.com/current?city=${encodeURIComponent(city)}`
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

MIT