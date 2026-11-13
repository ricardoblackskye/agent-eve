# Orchestrator persona: confirm instructions.md is the loaded source and document it (#629)

> **For Hermes:** Use the `ai-sdlc-workflow` + `test-driven-development` skills to implement this plan task-by-task. This is the first child of epic #628.

**Goal:** Make the Orchestrator's persona location unambiguous and self-proving — add a guard test that fails if `agent/instructions.md` is missing/empty, and a code comment at the `defineAgent` call stating the file is the persona and is loaded by Eve discovery (not imported). No behaviour change; the assembled prompt must stay byte-identical.

**Parent:** #628 (standardise Dark Factory personas on the `instructions.md` convention). This child is the **worked example** the other three children copy.

---

## Verified context (read before planning)

- `agent/agent.ts` defines the Orchestrator via `defineAgent({ model, ... })`. It does **not** import `instructions.md` — the persona prose is in `agent/instructions.md` and is loaded by **Eve's discovery convention** (`node_modules/eve/dist/src/discover/grammar.js` → `discoverInstructionsSource` accepts `instructions.md`, `instructions.ts`, or a `system.md`/`system.*` legacy slot). Confirmed by `grep` returning no `import ... instructions` in `agent/agent.ts` / `orchestrator-*.ts`.
- `agent/instructions.md` currently contains only persona prose (`# Identity`, `## Capabilities`, `## Guidelines`) — 19 lines, 656 bytes. No marker stating its role.
- `AGENTS.md:5` **already documents** the convention: *"Fresh projects use `agent/instructions.md`; a project may instead use `agent/instructions.ts` or files under `agent/instructions/`."* So the convention is known — the gap is that the file and the `agent.ts` call site don't *self-declare*, and nothing fails in CI if the file is deleted.
- Existing orchestrator tests: `tests/orchestrator-model.test.ts`, `tests/orchestrator-gate.test.ts`. Neither asserts the persona file's existence. Tests import via `../agent/orchestrator-model` and run from the repo root (vitest), so `path.resolve(process.cwd(), "agent/instructions.md")` is the correct way to touch the file from a test.
- `agent/instructions.md` is **not** under `agent/lib/dark-factory/`, so it is **exempt** from the doc-drift guard (`tests/doc-drift-guards.test.ts` only scans `agent/lib/dark-factory/*.ts`); no ADR-index or `docs/pages/*.md` link is required for this change.

## Why this matters

A deleted/renamed `instructions.md` means the Orchestrator silently boots with an **empty persona** — the worst kind of failure (no error, just a degraded agent). Today nothing catches it. This child adds the catch and records *why* the file is where it is, so a future reader doesn't "tidy" it into a location Eve won't load.

---

## Tasks (TDD — one behaviour per cycle)

### Task 1 — RED: guard test for the persona file

**Objective:** A test that fails if `agent/instructions.md` is missing or empty, and fails if `agent/agent.ts` does not declare the file as the Orchestrator persona loaded by convention.

**Files:**
- Create: `tests/orchestrator-instructions.test.ts`
- Modify (comment only): `agent/agent.ts`

**Step 1: Write the failing test** (`tests/orchestrator-instructions.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { readFileSync as _r, readFileSync as _read } from "node:fs"; // placeholder, replaced below
import { resolve } from "node:path";

const INSTRUCTIONS = resolve(process.cwd(), "agent/instructions.md");

describe("orchestrator persona source", () => {
  it("loads its persona from agent/instructions.md and is non-empty", () => {
    expect(existsSync(INSTRUCTIONS), "agent/instructions.md must exist").toBe(true);
    const stats = statSync(INSTRUCTIONS);
    const text = readFileSync(INSTRUCTIONS, "utf8");
    expect(stats.size).toBeGreaterThan(0);
    expect(text).toContain("# Identity");
  });

  it("declares instructions.md as the orchestrator persona at the defineAgent call", () => {
    const agentTs = readFileSync(resolve(process.cwd(), "agent/agent.ts"), "utf8");
    // The defineAgent call must state the persona comes from instructions.md via discovery.
    expect(agentTs).toMatch(/instructions\.md[^\n]*orchestrator persona/i);
  });
});
```

(Use a clean single `readFileSync` import in the real file — the doubled import above is only to show the shape; do not commit it.)

**Step 2: Run to verify failure** — `npx vitest run tests/orchestrator-instructions.test.ts`
Expected: the second `it` FAILS (`agent/agent.ts` has no such comment yet). The first `it` PASSES (file exists) — that part is the regression guard and is correct to pass now; only the declaration assertion is the genuine RED.

**Step 3: Commit the RED** — `git add tests/orchestrator-instructions.test.ts && git commit -F <msg>` with message:
`test(629): RED — guard that agent/instructions.md is the orchestrator persona`

### Task 2 — GREEN: declare the persona at the call site

**Objective:** Make the RED assertion pass with a code comment — zero behaviour change.

**Files:**
- Modify: `agent/agent.ts` (comment only, beside the `defineAgent` call around line 63–75)

**Step 1: Add the comment** above the `const definition = ... defineAgent({...})` block:

```ts
// The Orchestrator's persona lives in `agent/instructions.md` and is loaded by Eve's
// discovery convention — it is NOT imported here. Do not inline the persona into this
// file; edit instructions.md instead. Deleting the file boots the agent with an empty
// persona and fails silently. See tests/orchestrator-instructions.test.ts.
const definition =
```

**Step 2: Run to verify pass** — `npx vitest run tests/orchestrator-instructions.test.ts`
Expected: both `it`s PASS.

**Step 3: Commit the GREEN** — `git commit -F <msg>`:
`docs(629): GREEN — declare instructions.md as the orchestrator persona at defineAgent`

### Task 3 — Verify no drift + full suite

**Objective:** Prove the change is a documentation-only addition and nothing regressed.

**Steps:**
1. `npx tsc --noEmit` (clean — only a comment was added).
2. `npx vitest run` (full suite: confirm no NEW regressions; expect existing orchestrator tests unchanged).
3. **Prompt-byte check (parent #628 AC3):** the persona file `agent/instructions.md` was NOT edited, so the assembled prompt is byte-identical by construction. State this explicitly in the PR; no snapshot diff needed because the file is untouched.
4. Local lint gate (MANDATORY before push):
   - `npx -y cspell@8 --config .cspell.json tests/orchestrator-instructions.test.ts agent/agent.ts agent/instructions.md` — clear any findings (add words to `.cspell.json` only if pre-existing; the new comment uses ordinary words).
   - `npx -y markdown-table-formatter@1.6.1 --check .hermes/plans/*.md` and `npx -y markdownlint-cli@0.45.0 -c <cfg>` on this plan file (see ai-sdlc-workflow skill for the pinned versions and the `mailto:`/`MD040`/`MD026` traps). The plan file already avoids those.

**Step 4: Commit nothing further unless a lint fix is required; if so, commit it separately.** Then push the branch.

---

## Files likely to change

| File | Change | Risk |
| --- | --- | --- |
| `tests/orchestrator-instructions.test.ts` | NEW guard test | low |
| `agent/agent.ts` | One code comment beside `defineAgent` | none (comment only) |
| `agent/instructions.md` | **Not modified** (keeps prompt byte-identical) | n/a |
| `.hermes/plans/2026-11-11_orchestrator-persona-629.md` | This plan | n/a |

## Validation summary

- RED observed: the declaration assertion fails before Task 2.
- GREEN observed: both assertions pass after Task 2.
- `tsc --noEmit` clean; full vitest suite shows no new regressions.
- Local cspell/markdownlint clean on changed files.
- `agent/instructions.md` bytes unchanged → Orchestrator prompt identical to `main`.

## Risks / open questions

- **Source-regex test caveat:** the second assertion greps `agent/agent.ts` for a comment. A regex-on-source test proves the words exist, not that the runtime loads them — but here the *behaviour* (loading) is Eve's convention, already proven by `AGENTS.md:5` and the discovery code; the test's job is only to **pin the documentation** so it can't be silently removed. Acceptable for a doc-guard; noted so a reviewer doesn't mistake it for a behaviour test.
- **No prompt drift:** deliberately NOT editing `agent/instructions.md`, so #628 AC3 (byte-identical prompts) holds trivially. If the user later wants the self-declaration *inside* the markdown, it must be an HTML comment (`<!-- -->`) so Eve's markdown lower strips it from the persona — out of scope here.
- **No ADR required:** this is a documentation guard, not a vendor/seam/irreversible decision; no ADR per the ai-sdlc-workflow trigger test.

## Commit convention

- RED: `test(629): RED — guard that agent/instructions.md is the orchestrator persona`
- GREEN: `docs(629): GREEN — declare instructions.md as the orchestrator persona at defineAgent`
- Plan: `plan(629): orchestrator persona convention guard`

PR body will reference `Closes #629` and link parent `#628`.
