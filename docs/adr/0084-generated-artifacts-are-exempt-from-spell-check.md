# 0084 — Generated plan artifacts are exempt from the target's spell-checker

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

The Definition of Done (#659) will not let a run report `done` while the pull request's own checks are red, so the
plan artifact the factory writes into the target repository is now linted by that repository's MegaLinter like any
other changed markdown. One descriptor is `spell/cspell`.

The plan is **machine-authored prose**: the Architect model writes its summary, approach and task steps, so its
vocabulary is unbounded. cspell's dictionary is general English, not the target's domain language. Measured on
WebFeedPOC during the #212 end-to-end run:

```text
.hermes/plans/df-212.md:30:47  - Unknown word (prerendered)
```

`prerendered` is not a typo. That repository's own `package.json` ships a `build:prerender` script and a
`scripts/prerender.mjs`; the model derived an ordinary verb from the project's own noun. The check rejected the
repository's own jargon.

The artifact also cannot be repaired after the fact. Three properties combine:

1. the plan is rendered **after** the coding loop finishes, so the in-loop lint gate never sees it;
2. the Definition of Done has **no fix capability** — it is not given a sandbox and the runner wires no
   `attemptFixes`, so it can only enumerate findings;
3. rewriting the plan's prose to satisfy an external dictionary is not something a template can do for arbitrary
   vocabulary.

Together those meant a single rejected word could stop every run against a repository from ever completing, with no
code change able to clear it.

## Decision

The rendered plan carries a `<!-- cspell:disable -->` directive above its heading.

It applies to the generated file and nothing else: human-authored sources, tests and docs stay spell-checked, which
is where the check has real value. The directive is emitted by `renderPlanFile`, so it holds for every target
without amending any repository's configuration.

Where a repository owns its own lint config, the cleaner equivalent is to exclude the generated path from the
descriptor (`SPELL_CSPELL_FILTER_REGEX_EXCLUDE`), or to add the project's domain words to its `.cspell.json`. The
in-artifact directive is the portable form, because the factory cannot assume it may edit a target's config.

## Consequences

- A spelling mistake in generated plan prose is no longer caught. That is acceptable: the artifact is derived
  output, it is regenerated on every run, and its correctness is pinned by the plan tests rather than by a
  dictionary.
- cspell remains a required descriptor for the repository's own files, so the protection that justified it stays.
- A target repo that wants its own domain vocabulary respected should maintain `.cspell.json` words. That is a
  repository concern, not one the factory can resolve on its behalf.
- The same reasoning extends to any future generated artifact that lands in a target repository: exempt the
  generated file, keep the check on authored ones.