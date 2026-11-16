# Plan: Developer persona - relocate the code-author prompt prose (#631)

**Issue:** #631 (child of epic #628)
**Branch:** `feat/developer-persona-631`
**Base:** `origin/main` @ `f2df9a5`

## Goal

The Developer's static persona prose moves out of a TypeScript template literal in
`agent/lib/dark-factory/code-author.ts` and into a markdown source of truth, so "where do I edit the
Developer's personality?" has a consistent answer. The prompt bytes must NOT change: this is a
relocation of prose, not a rewrite, and a changed prompt invalidates the 9/9 eval baselines.

## Constraint measured, not assumed

The issue says to extract to `agent/lib/dark-factory/developer/instructions.md`. That is not
buildable. Verified on this machine:

```text
$ printf '# probe\n' > agent/lib/dark-factory/__probe.md
$ npm run eve:build
Discovery failed with 1 error(s) and 0 warning(s).
- Error: Expected "...\agent\lib\dark-factory\__probe.md" to be a supported
  authored module within "lib/".
```

Nothing local catches this: not the tests, not `tsc`, not cspell, not markdownlint, and not
`npm run build` (which runs the Next build only and never Eve's discovery).

Two in-repo precedents already met the same wall:

- **#630 (the sibling child, merged)** shipped a TS artefact, `agent/lib/dark-factory/architect-identity.ts`,
  and documented the error verbatim in its header.
- **`planning-guidance.ts`** keeps its markdown OUTSIDE `agent/lib` (`docs/superpowers/writing-plans.md`)
  and loads it with a runtime `readFileSync`, warning that such a file "cannot be dropped by output
  tracing the way a runtime file read could".

## Decision (user-approved)

**Both**: the markdown outside `agent/lib` is the SOURCE OF TRUTH, and a committed GENERATED
TypeScript module ships it - so there is no runtime file read and no bundling risk.

- Source of truth: `docs/dark-factory/developer/instructions.md`
- Generated artefact: `agent/lib/dark-factory/developer-identity.ts` (committed, compiled into the bundle)
- Generator: `scripts/sync-developer-persona.ts` - parses the markdown, renders the module; `--check` mode
  verifies without writing.

## The byte-identity contract

These are the exact static strings in `code-author.ts` today. Each becomes one labelled section of the
markdown and one exported constant. Nothing else about them changes.

| Section                 | Current value                                                                                                                                                                                |
|-------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `preamble`              | `You are Eve's Developer Agent. Execute the following ExecutionPlan:`                                                                                                                        |
| `target-files`          | `For each target file, provide the code to write.` + the `Return a JSON object where keys are relative file paths...` line + the `Example: { "app/chat.tsx": ... }` line, joined by newlines |
| `preserve-heading`      | `### YOU ARE MODIFYING THESE FILES: KEEP THE CODE THAT IS ALREADY IN THEM`                                                                                                                   |
| `preservation-contract` | the current `PRESERVATION_CONTRACT` text, verbatim                                                                                                                                           |
| `feedback-heading`      | `### YOUR PREVIOUS ATTEMPT FAILED - FIX THAT, DO NOT REPEAT IT`                                                                                                                              |
| `feedback-footer`       | `Return the full corrected contents of every target file, as the JSON object described above.`                                                                                               |

The dynamic parts (`JSON.stringify(plan, null, 2)`, `JSON.stringify(existing, null, 2)`, `feedback`) and
the ORDER of assembly stay exactly as they are.

Sections are delimited by HTML-comment markers so extraction is unambiguous and byte-exact while the
file still reads as prose:

```md
<!-- developer-persona:start target-files -->
For each target file, provide the code to write.
<!-- developer-persona:end target-files -->
```

## Tasks (strict TDD)

- **T1 (RED)** - `tests/dark-factory/developer-persona.test.ts`:
  - the artefact exists and exports the prose constants;
  - the committed artefact is byte-equal to `renderIdentityModule(parseSections(markdown))` of the
    committed markdown (newlines normalised) - the DRIFT guard, so editing the markdown without
    regenerating fails CI;
  - `code-author.ts` no longer carries the persona prose inline (the relocation is the deliverable).
  RED: the artefact and the generator do not exist yet.
- **T2 (GREEN)** - the markdown source of truth, the generator, the committed generated module, and
  `code-author.ts` interpolating from it. The existing `#281` / `#361` byte-for-byte tests are the
  regression oracle and must stay green **untouched**.
- **T3** - the golden prompt contract: pin the FULL assembled prompt (plan-only, plan+existing,
  plan+existing+feedback) against committed fixtures, mirroring `architect-prompt-contract.test.ts`, so a
  future prose edit must re-record them deliberately.
- **T4** - add the `developer-identity.ts` row to `docs/pages/dark-factory-modules.md` (the doc-drift guard)
  and recompute the module count.
- **T5** - ADR `0083` recording the deviation from the epic's literal convention, plus its index row.
- **T6** - gates: `npm run eve:build` (the real proof the markdown is outside `agent/lib`), then
  `npx tsc --noEmit --incremental false`, the full suite, and cspell / markdownlint / the pinned
  markdown-table-formatter / markdown-link-check on the changed files.

## Acceptance criteria mapping

- **AC1** (prose lives in markdown, not a TS template literal) - met by the source of truth; the shipped
  artefact is generated from it, which is what the Eve constraint permits (#630's documented compromise).
- **AC2** (signature kept, prompt bytes unchanged) - T2, with the existing tests as the oracle and T3 as
  the golden pin.
- **AC3** (`PRESERVATION_CONTRACT` importable from its current path) - `code-author.ts` re-exports it; it
  has no importer outside the module today, but its name and export site stay.
- **AC4** (the JSON-object instruction and the example object survive verbatim) - they are the
  `target-files` section, pinned by T3.

## Files

- `docs/dark-factory/developer/instructions.md` (new, source of truth)
- `agent/lib/dark-factory/developer-identity.ts` (new, generated + committed)
- `scripts/sync-developer-persona.ts` (new, generator with `--check`)
- `agent/lib/dark-factory/code-author.ts` (interpolate from the artefact; keep the exports)
- `tests/dark-factory/developer-persona.test.ts` (new)
- `tests/dark-factory/developer-prompt-contract.test.ts` + fixtures (new, golden)
- `docs/pages/dark-factory-modules.md`, `docs/adr/0083-*.md`, `docs/adr/README.md`

## Risks and open questions

- **The generator is a moving part.** Mitigated by the T1 drift test: a hand-edit of the artefact or a
  markdown edit without regeneration fails CI with both sides shown.
- **Where exactly the markdown lives.** `docs/dark-factory/developer/` is proposed; it must stay OUTSIDE
  `docs/pages/` so it does not become a tracked docs page with its own index row.
- **ADR or module header only.** The sibling #630 recorded its rationale in the module header. This plan
  proposes an ADR as well, because the decision deliberately deviates from the epic's stated convention;
  say so if you would rather keep it in the header only.
