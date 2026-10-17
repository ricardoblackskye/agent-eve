# eve Agent App

This project uses the eve framework: an agent is a directory of files under `agent/`, and eve compiles and runs it.

For a content-only change to the root agent's identity, purpose, tone, or response guidelines, edit its existing authored instructions. Fresh projects use `agent/instructions.md`; a project may instead use `agent/instructions.ts` or files under `agent/instructions/`. You do not need to read the framework docs for a content-only instructions change. A fresh project already has its selected model in `agent/agent.ts`; preserve that file unless the user asks to change the model.

## Read the docs before writing code

```sh
ls node_modules/eve/docs
```

Start with `docs/README.md`: it maps each task to the page that covers it. Read that page before authoring tools, connections, channels, skills, subagents, schedules, or deployment. In a workspace or local package install, resolve the installed `eve` package location first. If the package docs are missing, use https://eve.dev/docs.

Use a bounded authoring loop:

1. Read the relevant page and inspect only files you will modify or need to imitate.
2. Stop discovery once the file location, imports, and definition shape are clear. Implement the smallest complete behavior the user requested.
3. Run one narrow verification. Expand investigation only when it fails or the request needs project-specific details.

Follow links or inspect public types only when the routed page leaves the task unanswered. Do not recursively glob `node_modules`, enumerate the entire docs tree, or read unrelated scaffold files when the direct path is known. Package-manager links can hide files from recursive glob tools even though direct reads work.

## Prefer an existing integration

When a task names an external product or service, search the registry before implementing its integration. For a generic capability, author a tool instead.

```sh
eve registry search <query> --json
eve registry view <item>
```

Prefer items whose `implementation` is `native`; use Chat SDK adapters when no native channel fits. `registry view` links the item's documentation.

Install without driving interactive prompts:

```sh
eve add <item> --non-interactive
```

Exit code 0 means setup completed, 1 failed, and 2 needs an answer or a prerequisite. On exit 2, run the `next.command` from the final NDJSON event. For a non-secret question, replace its `<JSON value>` answer placeholder with the answer you collected; string values need JSON quotes. Never pass a secret in `--answer`. See `docs/install-integrations.mdx` for setup prerequisites.

## Use eve for Vercel operations

Use eve to link and deploy Vercel projects:

```sh
eve link --non-interactive --project <name-or-id> [--team <team-id-or-slug>]
eve deploy --non-interactive --yes [--project <name-or-id>]
```

A setup may report `eve link` as a prerequisite; run it, then retry the continuation. When a completed setup event has `deploymentRequired: true`, run the `next` command it reports.

## Validate the change

Run the validation the task requests. When it does not establish the behavior you changed, run the narrowest relevant check.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Coverage (#391)

Unit test coverage is measured by the `Unit Tests` job on every pull request, and gated by a RATCHET: the
build fails if coverage DROPS. It never fails for sitting below a fixed target.

```sh
npm run test:coverage                  # run the suite with coverage (writes ./coverage)
npm run coverage:ratchet               # the gate: compare against coverage-baseline.json
npm run coverage:ratchet -- --update   # record the new floor after an improvement, then commit it
```

`coverage-baseline.json` is the floor. Improve coverage and the gate tells you to run `--update`; a drop
fails with the metric, both percentages, and the cause. The gate also requires the test run to have PASSED,
reading the outcome from `coverage/vitest-report.json`, so a flaky failure is reported as a failing run
rather than as a coverage drop, and `--update` refuses so a flake cannot lower the committed floor.
Only `agent/` and `app/` are measured - see
`coverage.include` in `vitest.config.ts`, which is the one line that decides what the number means.

The baseline is recorded with the five Postgres test variables set (as CI does), because those suites RUN
in CI and SKIP without them; measuring without them understates the floor by about 5 points and weakens the
gate to the point where a real 5-point regression would pass. CI provides Postgres as a service container;
locally, start a disposable one first:

```sh
docker run -d --rm --name df-cov-pg -p 5432:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=darkfactory postgres:16-alpine

export DF_TENANT_TEST_DATABASE_URL="postgres://postgres@localhost:5432/darkfactory?sslmode=disable"
export DF_COST_BUDGET_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_RUN_HISTORY_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_USAGE_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_CONTROL_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"

npm run test:coverage && npm run coverage:ratchet
docker stop df-cov-pg
```

Measuring without the database is not wrong, but the numbers are not comparable to the baseline, and the
gate says so when the drop is large enough to be that cause rather than a regression.
