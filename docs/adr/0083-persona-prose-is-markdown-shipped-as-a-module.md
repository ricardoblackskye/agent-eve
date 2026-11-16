# 0083 — Persona prose is markdown, shipped as a generated module

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

Epic #628 standardises the Dark Factory's agent personas on the `instructions.md` convention, so
"where do I edit the Architect's personality?" has one answer. The obvious reading is a markdown file
beside each agent, the way `agent/subagents/<name>/instructions.md` already works.

That reading does not build for the Dark Factory roles, which are library modules the runner constructs
rather than eve-discovered agents. Eve's discovery validates the whole `agent/lib/` tree and rejects a
bare `.md` inside it:

```text
Expected ".../agent/lib/dark-factory/developer/instructions.md" to be a supported authored
module within "lib/".
```

Nothing local catches it: not the test suite, not the type-check, not the spell-check or markdown
linters, and not `npm run build`, which runs the Next build only and never Eve's discovery. Only
`npm run eve:build` fails. Sibling child #630 met the same wall for the Architect, and
`planning-guidance.ts` met it for the vendored Superpowers material — which is why that markdown lives
in `docs/superpowers/` and is read at runtime.

A runtime read is not acceptable for a persona. The file has to survive output tracing into the
deployed bundle, and a file that is missing at runtime would silently produce an empty prompt.

## Decision

Keep the markdown OUTSIDE `agent/lib` as the source of truth, and SHIP it as a generated TypeScript
module.

- `docs/dark-factory/developer/instructions.md` - the prose, in sections delimited by
  `developer-persona:start` / `developer-persona:end` markers, taken verbatim between them.
- `agent/lib/dark-factory/developer-identity.ts` - generated and committed, so it is compiled into the
  bundle rather than read at runtime.
- `scripts/sync-developer-persona.ts` - the generator, with a `--check` mode for the drift test.

The prompt builders interpolate the generated constants, and the assembled prompt bytes do not change:
`tests/dark-factory/developer-prompt-contract.test.ts` pins them against fixtures captured from the
implementation as it stood before the move.

## Consequences

Editing a persona no longer means editing a multi-hundred-line class: the prose is in one markdown file
with an explicit section contract, and the same shape can be reused for the next agent.

It costs a generated artefact and a drift test. Editing the markdown without running the script fails
CI with both sides shown, and editing the artefact by hand fails the same test, so the two cannot
silently disagree. A single-line section renders as one `const` and a multi-line one as an array joined
by newlines, which keeps the generated file reviewable.

It does NOT make the change self-explanatory: the placement rule - markdown outside `agent/lib`, module
inside - is a platform constraint a future reader cannot infer from the layout, which is why this record
exists.
