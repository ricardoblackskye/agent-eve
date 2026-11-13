# Orchestrator persona: author the Orchestrator's own persona in instructions.md (#629)

> **For Hermes:** Use the `ai-sdlc-workflow` + `test-driven-development` skills. First child of epic #628.

**Goal:** Give the Orchestrator its **own** persona. The requirement behind #628 is that *every* Dark Factory role has a
persona — an identity that states what that agent is and how it behaves — in that role's own `instructions.md`. The
Orchestrator's location is already correct (`agent/instructions.md`, loaded by Eve discovery), but its **content is
the stock Eve demo template**, so today the Orchestrator has no persona of its own. This plan authors it and pins it.

**Parent:** #628 (standardise Dark Factory personas on the `instructions.md` convention).

---

## Verified context (read before planning)

- **The file is the loaded source (confirmed).** `GET /eve/v1/info` on a running dev server reports the static system
  instruction with `sourceId: "instructions.md"`, `sourceKind: "markdown"`, `role: "system"`. Eve discovery loads it
  next to `agent/agent.ts`; nothing imports it.
- **The content is the stock template (the gap).** `agent/instructions.md` is 19 lines / 656 bytes: `# Identity` →
  "You are Eve Agent, an intelligent AI assistant built with the Eve framework by Vercel…" → `## Capabilities` →
  `## Guidelines`. Unchanged since the scaffold — `git log --follow -- agent/instructions.md` shows only `b3fa060`
  scaffold, `69cca08` OpenRouter config, `1f08478` prettier — and it is identical on `origin/main` and on this branch.
- **Every other role has its own persona, which is the whole point.**

  | Role | Persona file | Opening line |
  | --- | --- | --- |
  | Product Owner (subagent) | `agent/subagents/product-owner/instructions.md` | "You are the Product Owner subagent for the Agent Eve project…" |
  | Release Manager (subagent) | `agent/subagents/release-manager/instructions.md` | "You are the Release Manager subagent for the Agent Eve project…" |
  | Architect | inline in `architect-agent.ts` (→ #630) | "You are Eve's autonomous Architect Agent." |
  | Developer | inline in `code-author.ts` (→ #631) | "You are Eve's Developer Agent." |
  | Tester | none, by design (→ #632) | n/a |
  | Orchestrator | `agent/instructions.md` | "You are Eve Agent, an intelligent AI assistant…" (stock, **not its own**) |

- `agent/instructions.md` is **not** under `agent/lib/dark-factory/`, so it is exempt from the doc-drift guard.

## Already delivered (PR #636) — necessary, not sufficient

The earlier scope was *declare the file at the call site and pin it with a guard*, and that is implemented on
`docs/orchestrator-persona-629`:

- `agent/agent.ts`: a comment above `defineAgent` stating `instructions.md` is the Orchestrator persona, loaded by
  discovery, not imported.
- `tests/orchestrator-instructions.test.ts`: asserts the file exists, is non-empty, contains `# Identity`, and that
  `agent/agent.ts` declares it.

That work stays. It pins **where** the persona is, not **what it says** — which is what this rework adds.

## The changes needed

### 1. Author the Orchestrator persona (replace the stock template)

Rewrite `agent/instructions.md` with the Orchestrator's own identity, in the voice of the other roles. Draft to review:

```markdown
# Identity

You are Eve's Orchestrator Agent for the Agent Eve project — the Dark Factory's entry point.
You take a GitHub issue, establish what "done" means, and drive it to a reviewed pull request
by routing work to the Architect, Developer and Tester agents. You are decisive, you verify
before you claim success, and you stop and ask a human when a decision is genuinely theirs.

## Responsibilities

- Read the triggering issue and establish what "done" means before any work starts.
- Route work to the right agent: Architect to plan, Developer to implement, Tester to verify.
- Keep the plan honest — no scope widening and no invented requirements; a gap found mid-task
  becomes its own issue, never a widening of the current one.
- Opening a pull request is the terminal automated action. Never merge — a human reviews and merges.
- Park and ask when a decision needs a human (plan approval, an ambiguous requirement) instead
  of guessing.

## Guidelines

- Be concise and direct — don't over-explain unless asked.
- When you don't know something, say so clearly.
- Always verify your work before reporting success.
- Prefer showing working results over describing them.
```

### 2. Strengthen the guard so the stock template cannot come back

Extend `tests/orchestrator-instructions.test.ts`:

- keep: exists, non-empty, contains `# Identity`;
- add: the persona contains `Orchestrator`;
- add: the persona does **not** contain the stock boilerplate `an intelligent AI assistant built with the Eve framework`.

### 3. Consequence — the assembled prompt WILL change, so the evals must be re-run

#628's hard constraint ("assembled prompt byte-identical") exists because the Architect/Developer children (#630/#631)
are **relocations** of existing prose. The Orchestrator has **no existing persona prose to relocate**, so authoring one
**deliberately changes the Orchestrator's assembled prompt** — that is the requirement, not a regression. Therefore:

- the Orchestrator's prompt bytes will differ from `main` **by design** (this child is the exception to #628's
  byte-identical constraint; record that on #628);
- the eval suite must be **re-run and its baseline reviewed** (the 9/9 baseline was measured under the stock persona).
  A changed result is reviewed and intended, never waved through.

## Tasks (TDD — one behaviour per cycle)

### Task 3 — RED: the guard rejects the stock template

**Objective:** A test that fails while the persona is still the stock template.

**Files:** modify `tests/orchestrator-instructions.test.ts`.

1. Add the two assertions from Section 2.
2. `npx vitest run tests/orchestrator-instructions.test.ts` → expected RED (no `Orchestrator`; stock boilerplate still present).
3. Commit: `test(629): RED — guard that the orchestrator has its own persona`.

### Task 4 — GREEN: write the persona

**Objective:** Replace the stock template with the persona (Section 1), after the draft is approved.

**Files:** modify `agent/instructions.md` (only).

1. Write the approved persona. Keep the `# Identity` heading.
2. `npx vitest run tests/orchestrator-instructions.test.ts` → expected GREEN (both tests pass).
3. Commit: `docs(629): GREEN — author the orchestrator persona in instructions.md`.

### Task 5 — Verify

1. `npx tsc --noEmit` (clean).
2. `npx vitest run` (full suite — no regressions).
3. `npx cspell -c .cspell.json agent/instructions.md tests/orchestrator-instructions.test.ts`
   (add words to `.cspell.json` only if pre-existing; the persona prose is ordinary English).
4. markdownlint on this plan file (pinned version per the ai-sdlc-workflow skill).
5. **Re-run the eval suite**; compare against the 9/9 baseline; update the baseline only for reviewed, intended changes.
6. Push; update PR #636.

## Files likely to change

| File | Change | Risk |
| --- | --- | --- |
| `agent/instructions.md` | Stock template → Orchestrator persona | **prompt bytes change → eval re-run** |
| `tests/orchestrator-instructions.test.ts` | +2 assertions | low |
| `agent/agent.ts` | (already done) call-site declaration comment | none |
| `.hermes/plans/2026-11-11_orchestrator-persona-629.md` | this plan | n/a |

## Risks / open questions

- **Persona wording is a product decision** — the draft in Section 1 needs the user's review before it is written.
- **Byte-identical is intentionally broken for this child.** If #628 wants that recorded, its acceptance criteria
  should note the Orchestrator exception.
- **Eval baseline** was measured under the stock persona; the re-run may legitimately differ and must be reviewed.
- **Source-regex test caveat** (carried over): asserting on the persona text proves the words exist, not that the
  runtime loads them — the *loading* is Eve's convention (already proven). The test's job is to pin the content.

## Commit convention

- RED: `test(629): RED — guard that the orchestrator has its own persona`
- GREEN: `docs(629): GREEN — author the orchestrator persona in instructions.md`
- Plan: `plan(629): rework for the orchestrator persona`

PR #636 will continue to reference `Closes #629` and link parent `#628`.
