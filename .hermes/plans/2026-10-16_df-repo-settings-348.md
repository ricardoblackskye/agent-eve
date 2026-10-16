# Dark Factory — per-repo settings (#348 R2) Implementation Plan

**Goal:** the Factory stops carrying single-repo assumptions outside the runner: per-repo settings
(board, actors) come from config, the remaining hardcoded owner/repo fallbacks go, and the label
literals collapse to the one canonical source.

**Architecture:** R1 made a run's **target repository** resolved-and-authorized. R2 makes the settings
that *depend on that repository* resolved the same way — one config file, one resolution rule, no
literal fallbacks. Decision recorded in **ADR 0038**.

---

## Decisions — CONFIRMED

Recorded here so the plan does not re-pose questions that are already answered.

1. **#367 is the UMBRELLA** for multi-repo work ("Allow Multiple Repos to be worked on" — it asks for
   exploration, a plan and a recommended approach). **#348 is closed when R2 lands**; #367 stays open to
   carry anything neither release covers.
2. **Per-repo settings live in CONFIG, not the database.** This is the recommendation #367 explicitly
   asks for; the reasoning is in *Config vs database* below and becomes ADR 0038.
3. **The Project is not the authority for the target repository.** The issue's own repository is (R1,
   ADR 0037). The Project identifies the **board** a repo's work is reported to — which is a setting,
   and therefore config.

## Context — what R1 landed, and what it deliberately left

Merged as #370 (`main` @ `e69ed2a`): `resolveTargetRepo` (`--repo` → `default_repo` → refuse),
`authorizeTargetRepo` (fail-closed `DF_WORKER_ALLOWED_REPOS`), `dark-factory.config.json`, the runner no
longer inventing `--issue`/`--branch`, ADR 0037. R1 touched the **runner and its config only**.

What R1 left behind, deliberately (its scope was the runner):

| Where                                                                | Literal                                                          | Consequence today                                            |
|----------------------------------------------------------------------|------------------------------------------------------------------|--------------------------------------------------------------|
| `agent/lib/backlog-provider.ts:107`                                  | `fallbackOwner = "ricardoblackskye"`                             | a story with no owner is attributed to one repo's owner      |
| `agent/subagents/release-manager/tools/read_current_notes.ts:33`     | `owner \|\| VERCEL_GIT_REPO_OWNER \|\| "ricardoblackskye"`       | reads notes from the wrong owner off Vercel                  |
| `agent/subagents/release-manager/tools/write_release_notes.ts:43`    | same                                                             | writes notes to the wrong owner off Vercel                   |
| `agent/subagents/sprint-reporter/tools/generate_sprint_report.ts:87` | `projectOwner \|\| SPRINT_PROJECT_OWNER \|\| "ricardoblackskye"` | reports on someone else's board                              |
| `generate_sprint_report.ts:89`                                       | `Number(SPRINT_PROJECT_NUMBER \|\| 3)`                           | **board number 3 for every repo**                            |
| `app/api/github/webhook/route.ts:520`                                | prompt: `login "ricardoblackskye", projectNumber 3`              | instructs an agent to use that board for **any** repo        |
| `agent/lib/dark-factory/definition-of-done.ts:272,339,769`           | `"needs-answer"` ×3                                              | three copies of a label that `trigger.ts:58` already defines |

The board line is the sharpest: it is not a fallback for a missing value, it is **the wrong board stated
confidently** for every repository but one.

## Config vs database — the recommendation (#367)

**Config. Not the database.** The reasons, in the order that decides it:

- **These are operator INTENT, not runtime state.** A board assignment or an actor allow-list is a
  decision someone made about how the Factory should behave. The database in this repo holds what
  *happened* (runs, events, usage, budgets) and authorization *records* (membership, tenants).
- **Config is reviewable and versioned; a row is neither.** A change to a board mapping appears in a pull
  request, next to the code that reads it, with a diff and a reviewer. A database row appears nowhere, and
  the next developer cannot tell intent from data.
- **This repo has no automatic migrations.** Per the control-plane notes there is no `npm run migrate`;
  migrations are applied by hand. Putting settings in the database therefore buys a per-environment
  manual step for something a checked-in file gives for free.
- **The failure modes differ in the direction that matters.** A missing config key fails at load, in one
  place, naming the file. A missing row fails at use, in whichever feature happened to read it.
- **One file already exists and is already validated** (R1's `runner-config.ts`): extending it keeps a
  single source rather than adding a fourth store to reason about.

The database remains the right home for anything with an *audit* requirement (who changed what, when) —
if a settings change ever needs that, it should be a deliberate follow-up with its own ADR, not a default.

## The design

**Config shape** — `dark-factory.config.json` grows a `repos` map, keyed `owner/repo` (the same
`REPO_PAIR_PATTERN` R1 uses), with only the fields something actually consumes:

```json
{
  "default_repo": "ricardoblackskye/agent-eve",
  "repos": {
    "ricardoblackskye/agent-eve": {
      "board": { "login": "ricardoblackskye", "number": 3 }
    }
  }
}
```

**Resolution for a setting**, mirroring R1's resolution exactly:

```text
1. an explicit argument (the tool's own parameter)
2. an environment override, where one already exists (SPRINT_PROJECT_OWNER, SPRINT_PROJECT_NUMBER)
3. the repo's entry in dark-factory.config.json
4. otherwise REFUSE, naming the repo and the file
```

**Step 4 is the point.** Today a repo with no board configured silently reports to board 3. After this
change it refuses and says which repo and which file — the same fail-closed posture as R1's allow-list,
applied to a setting rather than a permission.

**The label literals** become `TRIGGER_LABELS.question` (`trigger.ts:58`), so the label has one
definition. This is the tidy flagged on the R1 PR; it is a two-line change that prevents a rename from
silently leaving three call sites behind.

## Tasks (TDD, in order)

### Task 1 — per-repo settings in the config module

**Files:** extend `agent/lib/dark-factory/runner-config.ts`; extend `tests/dark-factory/runner-config.test.ts`.

Tests: a repo entry resolves; a repo with no entry refuses naming the repo **and** the file; a malformed
`board` (missing `number`, non-numeric, non-object) is refused by shape, not read as text; an entry for a
different repo does not leak in; the config stays valid when `repos` is absent entirely (R1's file must
keep working — this is a compatibility requirement, not a nicety).

### Task 2 — the sprint reporter's board comes from config

**Files:** `agent/subagents/sprint-reporter/tools/generate_sprint_report.ts`; its test.

Tests: the argument still wins; the env override still wins over config; config supplies the board when
neither is given; with no board anywhere the call refuses naming the repo (replacing today's silent
board 3). The last test is the behavioural change, and it is asserted explicitly.

### Task 3 — the release-manager tools stop defaulting the owner

**Files:** `read_current_notes.ts`, `write_release_notes.ts`; their tests.

Tests: an explicit owner wins; `VERCEL_GIT_REPO_OWNER` still applies on Vercel (it is a real signal);
with neither, the tools refuse rather than attributing work to `ricardoblackskye`.

### Task 4 — the backlog provider's fallback owner

**Files:** `agent/lib/backlog-provider.ts`; its test.

Tests: a supplied owner is used as-is; with none, the provider refuses with a message naming the field.

### Task 5 — the label literals collapse

**Files:** `agent/lib/dark-factory/definition-of-done.ts`; its test.

Tests: the three sites add `TRIGGER_LABELS.question`; a source guard asserts no bare `"needs-answer"`
literal remains in the module, so the rename cannot come back.

### Task 6 — the webhook prompt stops naming a board

**Files:** `app/api/github/webhook/route.ts`; its test.

The prompt currently tells an agent the login and project number to use. It should instruct the agent to
read the repo's settings instead — a prompt that hardcodes a board is how a hardcode survives a refactor
of everything around it.

### Task 7 — document it

**Files:** `docs/pages/dark-factory-modules.md` (catalogue entry for the extended module), ADR 0038,
`.env.example` if any env var's meaning changes.

## Validation

```text
npx vitest run                                   # whole suite
npx tsc --noEmit --incremental false             # a bare run can pass on a stale build-info
npx cspell --no-progress <changed files>
npx -y markdownlint-cli2@0.13.0 --config <MD013-disabled config> <changed .md>
npx vitest run tests/adr-integrity.test.ts       # the new ADR must be linked from the index
node node_modules/eve/bin/eve.js build           # the gate `npm run build` does NOT run
```

MD013 is excluded deliberately: the accepted ADRs already carry 31 lines over 80 characters and fail that
rule on `main`, so it is not a blocking gate here. Every other rule stays on — that is what caught a
malformed heading in ADR 0037.

## Files likely to change

- extend `agent/lib/dark-factory/runner-config.ts`, `dark-factory.config.json`, `tests/dark-factory/runner-config.test.ts`
- `agent/subagents/sprint-reporter/tools/generate_sprint_report.ts` + test
- `agent/subagents/release-manager/tools/{read_current_notes,write_release_notes}.ts` + tests
- `agent/lib/backlog-provider.ts` + test
- `agent/lib/dark-factory/definition-of-done.ts` + test
- `app/api/github/webhook/route.ts` + test
- add `docs/adr/0038-per-repo-factory-settings-in-config.md` + index row
- `docs/pages/dark-factory-modules.md`

## Risks and open questions

1. **A repo with no board configured will now refuse** where it previously reported to board 3. That is
   the intended correction, but it *is* a behaviour change: any repo relying on the default must gain an
   entry. `agent-eve` gets one in config as part of this change, so the existing behaviour is preserved
   for it explicitly rather than by accident.
2. **The tenant axis is a different thing and must not be conflated.** Tenants are about *who may see*
   data; a repo is about *what work is done*. R2 adds no tenant dimension to these settings.
3. **`VERCEL_GIT_REPO_OWNER` stays** where it applies: on Vercel it is a real, platform-provided signal
   rather than a guess, so removing it would break a legitimate deployment path. What goes is the literal
   owner *after* it.
4. **Two config files still describe repos** (`release-manager.config.json` and
   `dark-factory.config.json`). ADR 0037 already flags the drift risk; if their fields converge they
   should merge, which is a follow-up rather than part of this release.
5. **#367 remains the umbrella.** If its Project-selection requirement turns out to mean "a Project item
   picks the repo" rather than "the Project picks the board", that contradicts ADR 0037 and needs a new
   ADR superseding it — an explicit decision, not a quiet reversal.
