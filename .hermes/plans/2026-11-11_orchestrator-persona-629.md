# Orchestrator persona: a SEPARATE Orchestrator agent; the root chat stays default Eve (#629)

> **For Hermes:** Use the `ai-sdlc-workflow` + `test-driven-development` skills. First child of epic #628.

**Goal:** Give the Dark Factory **Orchestrator its own persona**, inside its **own agent**, so the **ROOT chat agent
stays the original default Eve** assistant. Every role owns its persona, and the Orchestrator must never be adopted
by the root chat.

**Parent:** #628.

---

## Corrected intent

- **ROOT chat agent** (`agent/agent.ts` + `agent/instructions.md`) = the **default Eve** assistant. It is what the
  front page talks to (`app/chat.tsx` -> `/api/eve/v1` -> `/eve/v1`), and it is the agent that will later be able to
  ask the other agents where they are.
- **Orchestrator** = a **distinct agent** with its own persona — never the root.

## Delivered in this PR — the revert

Writing the Orchestrator persona into `agent/instructions.md` made the ROOT chat adopt the Orchestrator identity, so
the front page began talking as the Orchestrator. Reverted:

- `agent/instructions.md` restored to the original default Eve persona (byte-identical to `origin/main`);
- the `agent/agent.ts` call-site comment corrected (it had declared the file the *Orchestrator* persona);
- `tests/orchestrator-instructions.test.ts` flipped: it pins the ROOT persona as default Eve and asserts it does
  **not** contain the Orchestrator.

## Verified context (read before planning)

- `agent/subagents/` = `product-owner/`, `release-manager/`, `sprint-reporter/` only — **no Orchestrator agent**.
- The word "orchestrator" in code (`orchestrator-model.ts`, `buildDynamicOrchestratorModel`, `createOrchestratorGate`)
  is the ROOT agent's **dynamic-model plumbing**, not a separate agent. #628's role table conflated the two.
- **How subagents are reached: the ROOT agent DELEGATES to them.** The webhook already does this —
  `app/api/github/webhook/route.ts:664` (*"Please delegate to the Product Owner subagent…"*) and `:515`
  (*"…the Sprint Metrics Analyst subagent…"*). Child streams exist at
  `/eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream`.
- The Dark Factory handoff POSTs `{ message: renderHandoffMessage(intent), runId, resume }` to `/eve/v1/session`
  (`agent/lib/dark-factory/entry.ts`), and `renderHandoffMessage` names no persona — so today the **ROOT** agent
  receives it.
- Subagent file pattern (from `agent/subagents/product-owner/`): `instructions.md` (persona prose) + `agent.ts`
  (`defineAgent` with a `description`, and TWO complete model branches — static or governed dynamic — because a
  spread-built object widens the union and matches neither; a dynamic model forbids `modelContextWindowTokens` as a
  sibling).

## The changes needed

### 1. Create the Orchestrator subagent

- `agent/subagents/orchestrator/instructions.md` — the Orchestrator persona (draft below).
- `agent/subagents/orchestrator/agent.ts` — mirror `product-owner/agent.ts`: a `description`, the two-branch
  `defineAgent`, and a cost gate with category **`orchestrator`** so it shares the existing budget
  (`DF_COST_BUDGET_ORCHESTRATOR_USD`).

### 2. Wire the Dark Factory handoff to the Orchestrator

Make the handoff instruct delegation, mirroring the established wording, e.g. prefix the message with
*"Please delegate to the Orchestrator subagent."* — then the ROOT agent (default Eve) stays Eve and hands the run to
the Orchestrator, exactly as `needs-story` reaches the Product Owner.

### 3. Guards (TDD)

- `agent/subagents/orchestrator/instructions.md` exists, is non-empty, and names the Orchestrator.
- ROOT `agent/instructions.md` does **not** contain the Orchestrator (delivered).
- `renderHandoffMessage(intent)` instructs delegation to the Orchestrator subagent.
- `agent/subagents/orchestrator/agent.ts` exports a definition carrying a `description`.

### 4. Note for #628

This child CREATES an agent, so the handoff path changes **by design** — unlike #630/#631, which are byte-identical
relocations. #628's constraint should record that distinction.

## Draft persona (needs review before it is written)

```markdown
# Identity

You are the Orchestrator subagent for the Agent Eve project — the Dark Factory's entry point.
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

## Tasks (TDD — one behaviour per cycle)

### Task 6 — RED: the Orchestrator subagent must exist and be named

- Add a guard asserting `agent/subagents/orchestrator/instructions.md` exists, is non-empty, and matches
  `/Orchestrator/`.
- Run it: expected RED (the files do not exist yet).
- Commit: `test(629): RED — the orchestrator needs its own subagent persona`.

### Task 7 — GREEN: create the subagent

- Write `agent/subagents/orchestrator/instructions.md` (the reviewed draft) and
  `agent/subagents/orchestrator/agent.ts` (mirroring `product-owner/agent.ts`).
- Run the guard: expected GREEN.
- Commit: `feat(629): GREEN — add the orchestrator subagent`.

### Task 8 — RED/GREEN: the handoff delegates to the Orchestrator

- RED: assert `renderHandoffMessage(intent)` instructs delegation to the Orchestrator subagent.
- GREEN: add the delegation instruction to the handoff message.
- Commit: `test(629): RED — handoff delegates to the orchestrator subagent`, then
  `feat(629): GREEN — handoff delegates to the orchestrator subagent`.

### Task 9 — Verify

1. `npx tsc --noEmit`.
2. `npx vitest run` (full suite).
3. `npx cspell -c .cspell.json <changed files>`.
4. **Prove the delegated path locally**: `npm run df:local-run -- --repo <owner/repo> --issue <n> --allow-remote-store`
   against a fresh issue, and confirm the plan still parks (delegation must not break the run).
5. `npx eve eval --strict --exclude-tag production --url http://127.0.0.1:3000` with the dev server up, and confirm the
   front page still answers as **default Eve**.

## Files likely to change

| File | Change |
| --- | --- |
| `agent/subagents/orchestrator/instructions.md` | NEW — the Orchestrator persona |
| `agent/subagents/orchestrator/agent.ts` | NEW — description + two-branch `defineAgent` + cost gate |
| `agent/lib/dark-factory/entry.ts` | the handoff message instructs delegation |
| `agent/instructions.md` | REVERTED to default Eve (delivered) |
| `agent/agent.ts` | call-site comment corrected (delivered) |
| `tests/orchestrator-instructions.test.ts` | ROOT guard (delivered) + Orchestrator subagent guard |

## Risks / open questions

- **Extra hop.** Delegation means the ROOT agent runs one turn before the Orchestrator does — the same shape (and
  cost) as `needs-story` -> Product Owner. Acceptable, but it is a latency/cost change worth stating on the PR.
- **Cost category.** Use `orchestrator` so the new subagent shares the existing budget row.
- **Persona wording** is a product decision and needs review before Task 7.
- The `docs/pages/dark-factory-modules.md` doc-drift guard covers `agent/lib/dark-factory/*.ts` only, so
  `agent/subagents/orchestrator/` needs no catalog row.
- **Source-regex caveat** (carried over): asserting on persona TEXT proves the words exist, not that the runtime loads
  them — the *loading* is Eve's convention (already proven). The guards only pin the content.

## Commit convention

- RED: `test(629): RED — …`
- GREEN: `feat(629): GREEN — …`
- Plan: `plan(629): orchestrator subagent + handoff wiring`

PR #636 continues to reference `Closes #629` and link parent `#628`.
