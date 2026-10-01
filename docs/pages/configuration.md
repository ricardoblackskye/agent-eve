# Environment Variables

| Variable                      | Purpose                                                                   | Required            |
|-------------------------------|---------------------------------------------------------------------------|---------------------|
| `OPENROUTER_API_KEY`          | API key for OpenRouter model access                                       | Yes                 |
| `EVE_API_KEY`                 | Bearer token for Eve API authentication                                   | Yes                 |
| `DF_PLATFORM_PROVIDER`        | Platform adapter selector (`vercel` or `generic`; required in production) | Yes, production     |
| `DF_DEPLOYMENT_ENV`           | Generic adapter stage (`development`, `preview`, `production`)            | No                  |
| `DF_API_BASE_URL`             | Trusted Eve API origin; generic provider handoff target                   | For remote generic  |
| `VERCEL_PROTECTION_BYPASS`    | Vercel-only bypass, forwarded only for the Vercel adapter                 | Vercel only         |
| `DF_STATE_DRIVER`             | Dark Factory execution-memory store (`sqlite`; unset = fail-closed)       | No                  |
| `DF_STATE_DB_PATH`            | SQLite file path, required when `DF_STATE_DRIVER=sqlite`                  | No                  |
| `DF_STATE_DB_DIR`             | Optional sandbox root the state DB path must stay inside                  | No                  |
| `DF_DISPATCH_MAX_RETRIES`     | Dispatch retry budget                                                     | No                  |
| `DF_DISPATCH_BASE_DELAY_MS`   | Dispatch base backoff delay in ms                                         | No                  |
| `DF_METRICS_DRIVER`           | Observability store (`memory`; unset = in-process)                        | No                  |
| `DF_RUN_HISTORY_DRIVER`       | Durable ledger adapter (`sqlite` or `postgres`; unset refuses writes)     | Required for writes |
| `DF_RUN_HISTORY_DB_PATH`      | SQLite ledger path, required when driver is `sqlite`                      | SQLite only         |
| `DF_RUN_HISTORY_DATABASE_URL` | Standard PostgreSQL URL (Supabase-compatible)                             | PostgreSQL only     |
| `DF_WORKER_PROVIDER`          | Worker sandbox location (`local` dry-run; unset = local)                  | No                  |
| `DF_WORKER_ALLOWED_REPOS`     | Fail-closed allow-list of repos a worker task may target                  | No                  |
| `DF_WORKER_RUNTIME`           | Runtime inside the sandbox (`node` \| `python`)                           | No                  |
| `DF_CREDENTIAL_TTL_SECONDS`   | Per-task credential lease lifetime (1..3600)                              | No                  |
