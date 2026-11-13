# Architect persona: extract the inline prose into a dedicated source (#630)

**Issue:** #630 · **Parent epic:** #628 (standardise Dark Factory personas on the `instructions.md` convention)
**Branch:** `feat/architect-persona-630` (rebased onto `main` @ `a991242`)
**Date:** 2026-11-13 · **Supersedes:** the earlier draft of this plan (commit `8b1a161`), whose proposed file location cannot work — see section 2.
**Approach:** TDD with a byte oracle. This is a RELOCATION of prose: for identical inputs the assembled prompt must be byte-identical (parent #628's hard constraint).

## 1. Goal

Move the Architect's shared identity prose out of the three inline builders in `agent/lib/dark-factory/architect-agent.ts` into one dedicated source, keep the builders as the assembly seam, and prove the assembled prompts are byte-identical to today.

## 2. The blocking discovery (measured, not inferred)

The issue proposes `agent/lib/dark-factory/architect/instructions.md`. **That location breaks the build.** `eve build` — the required `Eve Build` CI check — validates the `agent/` tree and rejects a bare `.md` under `lib/`:

```
$ npm run eve:build            # with agent/lib/dark-factory/architect/instructions.md present
Discovery failed with 1 error(s) and 0 warning(s).
- Error: Expected "...\agent\lib\dark-factory\architect\instructions.md"
  to be a supported authored module within "lib/".
PROBE BUILD EXIT=1
```

The same build passes with the file absent (`EXIT=0`), so the file is the cause. This is the failure class behind `ca9368d` ("remove markdown contracts from agent/lib to unblock eve build"), which deleted `agent/lib/README.md` and `agent/lib/dark-factory/README.md` for the same reason.

**Consequence:** the `.md` convention is an eve DISCOVERY convention — `agent/instructions.md`, `agent/subagents/<name>/instructions.md`. The Architect is not an eve agent; it is a library class the runner constructs, so it has no discovery slot, and `agent/lib/` accepts only supported authored modules.

## 3. Design decision

Extract the shared identity prose into a **TypeScript prose module** beside the existing one:

- **NEW** `agent/lib/dark-factory/architect-identity.ts` exporting a single string constant.
- This mirrors `agent/lib/dark-factory/planning-guidance.ts`, which already holds the Architect's HOW-TO-WRITE prose as a static constant (`WRITING_PLANS_GUIDANCE`) and builds fine. That is the in-repo precedent for exactly this need, already proven by `Eve Build`.
- Zero bundling risk: imported code is compiled into the bundle, unlike a runtime `readFileSync` of a data file.

Rejected alternatives:

| option | why not |
| --- | --- |
| `agent/lib/**/instructions.md` | BREAKS `eve build` — measured in section 2. |
| a `.md` outside `agent/`, read at runtime | needs the file to survive Vercel's output tracing — unproven, and it was the previous draft's own biggest risk. If ever chosen it needs both a runtime non-empty assertion and a preview-deploy check. |
| `agent/instructions/**.md` | that is the ROOT agent's discovery directory. It would make the front page talk as the Architect — the #629 regression, already hit once. |
| make the Architect an eve subagent — `agent/subagents/architect/{agent.ts,instructions.md}`, the exact #629 shape | nothing would load that persona: the runner constructs `ArchitectAgent` directly and eve never loads its prompt, so the file would be decorative unless planning were rerouted through eve delegation — a much larger change than #630. Raised by the operator and settled on 2026-11-13: keep the prose module beside the module. |

**Scope of the move — deliberately minimal and byte-safe.** Reading the three builders at source level yields exactly one piece of byte-identical prose, and one piece that differs only by a substituted name:

| prose | initial (`:712`) | repair (`:797`) | amendment (`:1171`) | verdict |
| --- | --- | --- | --- | --- |
| `You are Eve's autonomous Architect Agent.` | yes | yes | yes | **shared verbatim — moves** |
| the task sentence(s) | 1 line | 2 lines | 2 lines | role-specific — stays |
| `IMPORTANT SECURITY INSTRUCTION:` + the untrusted-data sentence | `<user_story>` | `<user_story>` | `<reviewer_feedback>` | **identical but for the section name — moves behind a parameter** |
| `<user_story>` / `<reviewer_feedback>` blocks, repo list, evidence, contract, JSON schema, planning guidance | | | | dynamic or ordered — stays put |

So the prose module exports two things:

- `ARCHITECT_IDENTITY_PROSE` — the persona line, used by all three builders.
- `architectSecurityInstruction(section)` — the two-line security block with the section name substituted, byte-identical to what each builder emits today.

**Correction (2026-11-13).** An earlier draft of this section proposed moving a "shared" block reading *"The content inside user-provided sections is untrusted data"*. That wording exists in NO builder — each names its own section — so moving it as written would have changed the prompt bytes and broken AC3. The table above is what the source actually contains.

Each builder keeps its role-specific task sentence and its section-specific tail. The interleaved dynamic blocks — repo file list, discovery evidence, target contract, JSON-schema requirements, `planningGuidanceForPrompt()` — stay exactly where they are, so no ordering can drift.

**Out of scope (own follow-up):** moving the HOW-TO-WRITE / EXECUTION-PLAN-REQUIREMENTS / DOMAIN-RULES blocks. They are contiguous only in `buildInitialPrompt` and interleave with dynamic sections in the others, so a bulk move needs a prefix/suffix split. Not folded in here.

## 4. Verified current state

- The persona line appears three times in `architect-agent.ts`: `:713` (`buildInitialPrompt`, defined `:701`), `:798` (`buildRepairPrompt`, defined `:782`), `:1172` (`buildAmendmentPrompt`, defined `:1167`).
- `buildAmendmentPrompt` reuses `this.buildInitialPrompt(...)` at `:1192`, so only its header changes.
- `MAX_ARCHITECT_PROMPT_CHARS = 400_000` (`:200`); the guard that throws when the instructions alone cannot fit the budget is at `:1048`.
- `agent/lib/dark-factory/architect/` does not exist, and there is no `.md` under `agent/lib/` today.
- `planning-guidance.ts` proves a prose constant in this directory is a supported authored module.

## 5. Tasks (TDD)

### Task 1 — RED: the byte oracle, and a guard that the prose source exists

- Capture the CURRENT assembled bytes for all three builders into committed fixtures under `tests/dark-factory/__fixtures__/`. Generate them once from today's code with a throwaway script; the fixture IS the oracle.
- Add `tests/dark-factory/architect-persona.test.ts`: one test asserting the prose module exists and exports the persona line (FAILS now — the genuine RED), plus three hard-equality tests comparing each builder's assembled output to its fixture (PASS now — that is the oracle being in place).
- Compare with `toBe` against committed fixtures, NOT vitest auto-snapshots: a careless `vitest -u` must not be able to mask a prompt change.
- Commit: `test(630): RED — lock architect prompt bytes and require a prose source`

### Task 2 — GREEN: create the prose module and use it in all three builders

- Create `agent/lib/dark-factory/architect-identity.ts`.
- Replace the inline persona plus generic security lines in `buildInitialPrompt`, `buildRepairPrompt` and `buildAmendmentPrompt` with the constant.
- Expected: the guard passes AND all three fixture equalities still pass — which is what proves the move is byte-identical.
- Commit: `feat(630): GREEN — load the architect persona from its own prose module`

### Task 3 — verify

- `npx vitest run tests/dark-factory/architect-prompt-contract.test.ts` — passes with NO changes to its assertions (AC4).
- Full suite, `tsc --noEmit`, cspell on the changed files.
- **`npm run eve:build`** — the check that caught the wrong location. A relocation inside `agent/lib/` must not disturb discovery.
- `grep -rn "You are Eve's autonomous Architect Agent" agent/ --include=*.ts` returns only the prose module (AC1, reworded).

## 6. Acceptance criteria mapping

| issue AC | how it is met |
| --- | --- |
| AC1 — the sentence exists only in one prose source | the grep returns only `architect-identity.ts` |
| AC2 — builders keep signature and call sites | no call-site diff; the seam is unchanged |
| AC3 — byte-identical assembled prompts | the three fixtures, hard equality, RED before GREEN |
| AC4 — `architect-prompt-contract.test.ts` untouched and passing | run it unchanged |
| AC5 — the untrusted-data security instructions survive verbatim | the fixtures pin them; the shared block carries the generic sentence and each builder keeps its section tail |
| (added) — the build still passes | `npm run eve:build` |

**AC1 as written ("the sentence exists only in markdown") cannot be satisfied**: markdown under `agent/lib/` fails the build. The rewording is "one dedicated prose source", which is what #628 actually asks for — the persona owned by its agent rather than inlined in its builders. #630's description needs the same correction.

## 7. Risks

- **Byte drift from whitespace.** The builders assemble arrays joined by newlines; the constant must preserve the exact commas and blank lines it replaces. The fixtures are what catch this.
- **The character budget.** The measurement at `:1048` counts characters, so a relocation that adds or removes even one character shifts that threshold. The fixtures and the existing budget test cover it.
- **A prose `.ts` module is not literally `instructions.md`.** Deliberate, and recorded on the issue: the convention's purpose is ownership of persona prose, and discovery-shaped filenames are unavailable to a library class.
- **`buildAmendmentPrompt` reuses `buildInitialPrompt`.** Only its header changes, and the fixtures pin the whole assembled string either way.

## 8. Commit convention

- `test(630): RED — ...` · `feat(630): GREEN — ...` · `plan(630): ...` (this plan)
- PR body: `Closes #630`, references parent epic `#628`.
