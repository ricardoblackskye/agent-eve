# Give the architect a target-scope rule: when uncertain, include the co-located spec (#787)

**Issue:** [agent-eve#787](https://github.com/ricardoblackskye/agent-eve/issues/787) (`enhancement`)
**Branch:** `feat/787-architect-target-scope` (from `origin/main` @ `774a475`, 0 behind)
**Status:** plan only. No code until GATE 1.

## Why we are doing this

The same story, planned twice against the same commit, produced different sets of files to change. One run included the
co-located test file, describing it as already existing and merely extended. The other left it out while its own prose
promised to add it. Both passed validation.

That difference decides whether the change arrives with its test updated. Under R2 the approved target set is what the
run is allowed to write, so a plan that omits the spec cannot write it - the run either fails, or ships a behavior
change with nothing pinning it. Which of those two plans an approver receives currently depends on the run.

**What changes:** the architect's guidance states that when a story changes rendered behavior, the co-located spec for
the file being changed belongs in `targetFiles` - and that when it is uncertain whether the change needs new test
cases, it includes the spec anyway.

**What this does not change:** it does not make target selection deterministic, and it does not remove variance. It aims
at the one difference R4 measured - whether the spec is in scope - and whether that is enough is decided by re-running
R4's measurement, not by argument.

## The evidence, and the recon that shaped the design

R4 (#781) measured the identical story against one commit, run serially:

|               | Run A                             | Run B         |
|:--------------|:----------------------------------|:--------------|
| `targetFiles` | `src/App.jsx`, `src/App.test.jsx` | `src/App.jsx` |
| AC mappings   | 3                                 | 4             |
| validation    | Passed                            | Passed        |

The divergence is a **scope** difference, not a random one. And the recon found why nothing caught it:

| what                                                | where                                                                                                      |
|:----------------------------------------------------|:-----------------------------------------------------------------------------------------------------------|
| the shared planning guidance                        | `agent/lib/dark-factory/architect-prompt.ts`, via `planningGuidanceForPrompt()` (`architect-agent.ts:755`) |
| the targetFiles schema the model receives           | `architect-agent.ts:764`                                                                                   |
| the rationale rule it already follows               | `architect-agent.ts:770`                                                                                   |
| the **repair** prompt's version of this instruction | `architect-agent.ts:843`                                                                                   |

**That instruction already exists in the repair path - and Run B was never repaired.** Its plan passed validation, so no
repair ran and the wording never applied. A rule that only fires on a repair cannot shape the first answer.

## Design

1. **The rule belongs in the shared guidance**, so it applies to the first attempt. The repair prompt's version is
   derived from the same exported text rather than duplicated, so the two cannot drift apart.
2. **Stated as a permission, not an obligation** - and the asymmetry is the argument: the approved set is what a run
   **may** write, not what it must write. An unneeded file in the set costs nothing; a missing one blocks the write. So
   "include it when uncertain" is the safe default, and it is the specific difference between the two measured runs.
3. **Phrased in general terms**: the co-located spec **for the file being changed**. No repository, vendor, framework,
   language or path appears - the same principle the whole factory is held to.

## Tasks

### Task 1 (RED) - the guidance states the scope rule

Asserted against the exported guidance, not against whatever prompt the model happens to receive.

### Task 2 - it states the "when uncertain, include it" default

The half that addresses the measured divergence: Run B did not omit the spec out of policy, it omitted it out of
uncertainty.

### Task 3 - the repair path derives the same rule

Asserted as agreement between the two, so they cannot drift into contradicting each other.

### Task 4 - the guidance names no repository, vendor or framework

Asserted as an absence, the shape used for R2's "does not widen the approved set": the provider-agnostic principle is
one a later well-meaning edit relaxes, so it is pinned.

## The measurement this issue is accepted by

R4's protocol, re-run: two issues with **byte-identical bodies**, one **pinned commit**, run **serially** (one dev
server, one store), then `targetFiles` diffed and recorded on the issue.

Both outcomes are legitimate closes:

- **variance reduced or gone** - closes with "variance reduced by instruction; no selector needed";
- **variance persists** - that is the evidence warranting a selector, filed as a new issue with this measurement
  attached.

Two samples quantify a difference; they do not estimate a rate. That limit is carried over from #781 and stated in
advance, so the conclusion cannot grow stronger than the evidence.

## Verification

- RED then GREEN committed separately, each verified in its direction.
- `tsc --noEmit` clean, cspell over changed files, the module catalogue check if a documented module changes, and the
  full gate plus the coverage ratchet **before** the re-measurement.
- The two live runs create two WebFeedPOC issues, discarded once the measurement is recorded; their claims are then retired.

## Out of scope

- **A deterministic selector.** Evidence-gated on the re-measurement above, exactly as #787 states.
- **#784** - surfacing the classification the choice rests on. That makes divergence legible; this reduces it. Separate
  issues, and neither blocks the other.
- **Any repository-specific target rule.**
