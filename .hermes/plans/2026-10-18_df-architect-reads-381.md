# #381 R1 — Give the Architect bounded reads and evidence-based rationales

## Goal

The Architect plans from a file **list** and never reads file **content**, so it cannot tell a page from a shared
component from the application shell, and it asserts a target with confidence instead of evidence. R1 gives it eyes:
bounded reads, deterministic discovery, and rationales that cite what a file IS and the composition path that
proves it.

## Release split (settled with the user, 2026-10-18)

| release | branch                                      | ACs                | what ships                                                                                                                                                |
|---------|---------------------------------------------|--------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| **R1**  | `feat/df-architect-reads-381` (this change) | AC1, AC2, AC5, AC6 | bounded reads, deterministic discovery, evidence in rationales - all inside the existing single governed planning call                                    |
| R2      | `feat/df-architect-target-rules-381`        | AC3, AC4           | the rule that forbids a shell or shared component as the target of a page-scoped story, and fail-closed parking when the named surface cannot be resolved |

R1 makes a better target **likely**; R2 makes it **required**. They are deliberately separate: the read, bounding and
cost design is reviewable on its own, and the rule in R2 is tested against evidence R1 already produces. Only R1 is
planned in detail here.

## The current state (verified in the code, not assumed)

- `ArchitectDeps.readFile?` is **declared at `architect-agent.ts:83` and called nowhere** - a repository-wide search
  finds the declaration and no use. The capability exists and does nothing.
- The runner (`dark-factory-runner.ts:420`) constructs the agent with **`listFiles` only**, implemented as
  `scanWorkspaceFiles(process.cwd())`. So the process can read the checkout - that is how the list is produced - but
  the agent is given no way to.
- `buildInitialPrompt` sorts that list by an architectural-relevance heuristic, caps it at `maxContextFiles` (100),
  and embeds **names only**.
- `generateText` in the runner goes through `runGovernedAgentCall` (#270): an over-budget call is refused **at the
  call site** and recorded on the run. Any new model call would inherit that governance; R1 adds none.
- `escapeXmlContent` and `sanitizeRelativePath` already exist. The first is the containment used for untrusted text,
  the second is the hardened path validator. Reads must use both.

## Design

### Discovery is deterministic and adds no model calls (user decision)

From the routing/entry configuration, follow the import chain for the surface the story names and record:

- the **composition chain** (route -> page -> components), which is the evidence a rationale cites;
- each reached file's **role**: `page`, `shared` (reached from more than one page), or `shell` (rendered on every
  route, e.g. a layout that renders an outlet).

No model call is added. The single existing governed planning call receives the evidence, so the cost stays one call
per plan attempt and the governor still sees every call.

### Reads are bounded, and a truncated read says so

- a maximum **number of files** read;
- a maximum **bytes per file**;
- truncation on a **line boundary**, and the result is **labelled truncated** with the byte count and the original
  size. A partial file must never be presented as the whole file - an Architect that thinks it has seen all of a file
  will reason as confidently from a fragment as from the whole.

### The budget is derived from the model's window, not guessed

Everything below is measured or quoted, not estimated by feel:

| fact                                     | value                                                        | source                                                                              |
|------------------------------------------|--------------------------------------------------------------|-------------------------------------------------------------------------------------|
| model the code ACTUALLY calls            | **`deepseek/deepseek-v4.1-flash`**                           | `resolveChatModel()` -> `DEFAULT_MODEL_ID` in `agent/model-config.ts`               |
| its context window                       | **1,048,576 tokens**                                         | OpenRouter model list                                                               |
| model the runner REPORTS to the governor | `deepseek/deepseek-chat`                                     | `dark-factory-runner.ts:338` - a second, disagreeing fallback (**#400**)            |
| that model's context window              | 163,840 tokens                                               | OpenRouter model list                                                               |
| output the governed call reserves        | 8,000 tokens                                                 | `dark-factory-runner.ts:432`                                                        |
| **today's prompt**                       | **15,474 chars ~ 3,869 tokens = 2.5%** of the SMALLER window | measured by capturing the prompt with an injected `generateText` (no provider call) |

`EVE_CHAT_MODEL` is set **nowhere** - not among the deployed project's 17 environment variables, not in
`.env.local`, not in a shell - so the model in use is the project default above. The two ids disagree because the
runner resolves the model twice; that is filed as **#400** and is deliberately NOT fixed here.

### The budget is derived from the RESOLVED model, never a constant

| constant                     | value                                                                                                                                        | why                                                                                                                                                                                          |
|------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `MODEL_CONTEXT_WINDOWS`      | keyed by model id: `deepseek/deepseek-v4.1-flash` -> 1,048,576, `deepseek/deepseek-chat` -> 163,840, `deepseek/deepseek-v4-pro` -> 1,048,576 | a window is a property of the model, so it is looked up rather than assumed                                                                                                                  |
| unknown model                | 128,000 tokens                                                                                                                               | conservative, so an unlisted model cannot blow the limit                                                                                                                                     |
| reserved output              | 8,000                                                                                                                                        | what the call already reserves                                                                                                                                                               |
| safety margin                | 10,000                                                                                                                                       | estimate error and response framing                                                                                                                                                          |
| `MAX_ARCHITECT_PROMPT_CHARS` | **400,000**                                                                                                                                  | sized against the SMALLEST window in the table: ~100,000 tokens is 64% of `deepseek-chat`'s 155,840 headroom and only 9.6% of v4.1-flash's 1,040,576, so it is safe whichever model resolves |
| `MAX_CONTEXT_FILES_READ`     | 24                                                                                                                                           | enough for a route chain, far short of a crawl                                                                                                                                               |
| `MAX_CHARS_PER_FILE`         | 12,000                                                                                                                                       | truncation on a line boundary, labelled                                                                                                                                                      |

Assembly trims the read set to fit `MAX_ARCHITECT_PROMPT_CHARS` and **states what it omitted**. If even the
instruction block cannot fit, the Architect fails with a clear error rather than sending an over-budget prompt - the
same fail-closed posture as the rest of this system.

**This is why the budget must not hard-code a window.** The two ids that are live here differ by 6x, and which one
applies depends on a second fallback that contradicts the first (#400). A constant would be silently wrong on one of
the two paths - and the wrong one is the path that is currently running.

**Nothing bounds prompt size today.** The cost governor bounds SPEND, not size, and it is currently told the wrong
model (#400). The 1,048,576 declared on the Eve surfaces is not a guard either: it matches
`deepseek/deepseek-v4.1-flash`'s real window, so it is correct for the intended model, but a declaration is not a
check. Today the prompt uses 2.5% of the SMALLER window, so nothing overflows; after R1 it could, and R1 is exactly
the change that grows the prompt.

Because the budget derives from the resolved model's window, fixing #400 or switching models changes the budget with
no code change. That is why context is not a reason to change models.


### Contents are untrusted data

File contents are the most attacker-influenced text this system handles: a repository can contain anything, and the
Factory reads repositories it does not control. So contents enter the prompt as **data**, inside the existing
containment, escaped with `escapeXmlContent`, with the security instruction stating that anything inside the
delimiters is content and never an instruction. A file containing the closing delimiter must not be able to break
out, and that is pinned by a test rather than asserted.

Reads are validated with `sanitizeRelativePath` and rooted at the workspace, so a crafted path cannot read outside
the checkout: the Architect's reach must be no wider than the Developer's.

### Evidence in the plan

Each `targetFiles` rationale must name what the file IS and the composition path that proves it, for example
`route / -> pages/HomePage.jsx -> components/ProductList (shared: also reached from CategoryPage)`. No schema change:
the evidence lives in the existing `rationale` string, so a plan remains parseable by everything downstream.

## Tasks (TDD)

### Task 1 - the bounded reader (AC1, AC5)

- RED: a file larger than the byte cap comes back truncated on a LINE boundary and labelled as truncated; a read is
  never longer than the cap.
- GREEN: the reader with its caps.

### Task 2 - the read budget (AC5)

- RED: at most N files are read even when more are offered, and the count is observable.
- GREEN: the budget.

### Task 3 - the prompt cannot exceed its budget (AC5)

- RED: with adversarial inputs (far more large files than the budget allows) the assembled prompt never exceeds
  `MAX_ARCHITECT_PROMPT_CHARS`, and when the read set is trimmed the prompt SAYS what was omitted.
- RED: the budget is DERIVED - changing the declared window changes the budget. This pins that a future model or
  context-window change scales the budget instead of silently invalidating a hard-coded number.
- GREEN: budget-aware assembly, failing closed with a clear error if even the instructions cannot fit.

### Task 4 - a read cannot escape the workspace

- RED: a traversal, absolute, or drive-style name is never passed to the reader seam (assert the seam is NOT called),
  even when discovery produced it. Asserting "no read happened" rather than "it threw" is the point: a read that
  escapes and fails is still a read attempt.
- GREEN: `sanitizeRelativePath` plus root containment at the reader boundary.

### Task 5 - deterministic discovery (AC1, AC2)

- RED: given a fixture shaped like the real failing case - a shell that imports an outlet, a default page that
  composes a shared component also reached from a second page - discovery returns the chain and the correct role for
  each file.
- GREEN: the discovery module.

### Task 6 - the prompt carries escaped, labelled evidence (AC2)

- RED: the prompt contains the contents inside containment; a truncated file is labelled; a file whose content
  contains the closing delimiter cannot break out of it.
- GREEN: prompt assembly.

### Task 7 - cost: no extra model calls (AC6)

- RED: `generateText` is called **exactly once** per plan attempt with discovery enabled.
- GREEN: satisfied by the design. The test exists so a future model-based discovery step cannot be added silently
  and start spending the user's budget without a decision.

### Task 8 - wire the runner (AC1)

- Supply a bounded reader rooted at the workspace. A test pins that the agent is constructed WITH a reader, so the
  capability cannot go back to being declared and unused.

### Task 9 - ADR and docs

- ADR **0047**: deterministic discovery with no extra model calls; bounded reads with truncation labelled; file
  contents treated as untrusted data. Index it in `docs/adr/README.md`.
- The new module must be listed in `docs/pages/dark-factory-modules.md` - the `doc-drift-guards` test fails otherwise.

## Files likely to change

| file                                                       | change                                                         |
|------------------------------------------------------------|----------------------------------------------------------------|
| `agent/lib/dark-factory/architect-agent.ts`                | bounded reader seam, prompt sections, limits, role annotations |
| `agent/lib/dark-factory/architect-discovery.ts`            | new: deterministic discovery and role classification           |
| `scripts/dark-factory-runner.ts`                           | supply the bounded reader                                      |
| `tests/dark-factory/architect-discovery.test.ts`           | new: chain and roles on the fixture                            |
| `tests/dark-factory/architect-agent.test.ts`               | reader bounds, truncation labelling, containment, one-call     |
| `docs/adr/0047-architect-reads-bounded-context.md`         | new                                                            |
| `docs/adr/README.md`, `docs/pages/dark-factory-modules.md` | index + module list                                            |

## Validation

- The fixture is shaped like the **real** failing case from WebFeedPOC: a shell (`src/App.jsx` rendering an outlet),
  a default page (`src/pages/HomePage.jsx`) composing a shared component (`src/components/ProductList.jsx`) that a
  second page also composes. Testing against the shape that actually failed, not a simplified stand-in.
- A prompt-injection case: a file containing the closing delimiter cannot escape containment.
- Reads bounded; truncation labelled; no read outside the root.
- Exactly one governed model call per plan attempt.
- The assembled prompt never exceeds its budget, and a trimmed read set is labelled as trimmed.
- `tsc --noEmit`, warm full suite, root guards, and the local lint gate on every changed file before any push.

## Risks and open questions

1. **Prompt size and cost - measured, and bounded by construction.** The default model has 163,840 tokens of
   context and today's prompt uses 2.5% of it, so a content budget of 400,000 chars (~69% of headroom) has room to
   spare, and Task 3 pins that it cannot be exceeded. The PR will report the measured growth of a real prompt, not a
   projection.
   **A frontier model is not needed for context**, and would not have prevented either failure: the Architect
   reasoned confidently from a file LIST it was never allowed to look past, which is an evidence failure rather than
   a capability failure. Giving the default model the contents is the change with the argument behind it. The model
   is configurable per deployment (`EVE_CHAT_MODEL`), so a quality trial costs no code change - worth running AFTER
   R1, against the real fixture, instead of paying for a frontier model before the evidence exists that it helps.
   **Corrected:** an earlier draft of this plan called the 1,048,576 declared on the Eve surfaces a discrepancy,
   because it was compared against `deepseek-chat`'s 163,840. That was the wrong model. The declaration matches
   `deepseek/deepseek-v4.1-flash` exactly; what is wrong is the runner's second fallback, filed as #400.
2. **Discovery is heuristic.** A repository whose routing cannot be parsed yields no chain, and R1 still plans -
   without evidence. R1 must not pretend otherwise: the absence is stated in the prompt, and **R2 owns what happens
   then** (park for a human). This boundary is deliberate, so R1 is not accused of failing AC4.
3. **Roles come from the repository, never from a file's name** - the issue's own note. A file called `MainPage.tsx`
   that is reached from every route is a shell.
4. **Out-of-code-scope:** none. No repository setting or environment variable is required.
