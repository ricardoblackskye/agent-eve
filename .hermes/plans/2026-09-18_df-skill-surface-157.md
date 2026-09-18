# #157 — a real skill-set surface (AC8, implemented rather than assumed)

**Branch:** `feat/df-skill-surface-157` (off `origin/main` = `f6007cb`, which includes #159's operator CLI)
**Issue:** #157 · third item in the #157–#160 sequence; #160 (PR #165) and #159 (PR #166) are merged

## Settled design (agreed on the issue before any code was written)

- A skill is a **capability grant** — a named capability, defined by the tool/permission delta it grants.
- The controller may **only propose**; enabling requires the **operator gate** (#159's CLI). Widening is
  never automatic; revoking **narrows** and is safe to automate.
- Declarations live in the **`StateStore`** (the R4b adapter seam); the *code* stays in the repo.
- **Durable until revoked**, with an optional expiry.
- Revoking reuses the existing versioned `VersionHandle` machinery.
- Autonomous skill *discovery* is **out of scope** — proposals come from an explicit operator request.

## The finding that decides the scope

`ALLOWED_TOOLS` is the **only** tool vocabulary in the codebase — a grep for tool-like names across
`agent/lib/dark-factory/` returns exactly its four members and nothing else:

```
developer-agent.ts:304-307   "git_clone"  "read_file"  "write_code"  "run_tests"
```

The worker protocol takes a free-form `command: string` executed by the provider (`exec(handle, command)`),
so there is no registry a skill could add a tool *to*. **A skill that claimed to grant a new tool would be
inventing capability that does not exist** — so this surface does not offer that pretence.

What genuinely widens capability today is the **file-extension allow-list**:

```
ALLOWED_SKELETON_EXTENSIONS = new Set([".ts", ".tsx", ".json", ".md", ".css", ".yml", ".yaml", ".txt"])
```

`.sql`, `.sh`, `.graphql` and `.prisma` are refused by `applySkeletalMap` today. A skill that grants one of
those is a real widening — and it is a *visible* one, because the refusal path is already tested.

## REVIEW findings (from the code, not assumed)

- **`TunableSurface<T>` is minimal**: `id`, `read(): T`, `stage(next): Promise<VersionHandle<T>>`. Note
  `read()` is **synchronous**, so a store-backed surface must load its snapshot in an async factory and keep
  it in memory — otherwise the interface cannot be satisfied.
- **`VersionHandle<T>`** carries `previousVersion`, `previous`, `next`, `apply()`, **idempotent** `revert()`
  and `isApplied()`. `IterationBoundSurface` additionally mints `${id}@v${n}` versions and throws
  `SupersededVersionError` when a stale handle tries to act (`assertCurrent`).
- **`proposeFromObservation` cannot produce a skill proposal**: it is typed
  `surface: TunableSurface<number>` and hardcodes `kind: "bounded-tuning"` with `current + step` arithmetic.
  A skill proposal needs its own producer with `kind: "access-widening"`.
- **The gate already exists**: `self-improve.ts` blocks an `access-widening` proposal with
  `"operator gate missing"` / `"operator gate declined"`. #159 merged, so the gate is now *armable* — the two
  issues meet here, and this plan proves it end to end.
- **Neither allow-list is parameterisable** — both are module-level `const` sets, consulted inside
  `applySkeletalMap` and the tool-permission check.

## Design

### 1. `agent/lib/dark-factory/skills.ts` — the catalogue and the resolution rule

```ts
export type SkillGrant = { extensions?: string[]; tools?: string[] };

/** Exhaustive: adding a member to SKILLS is the only way to add a skill. */
export const SKILLS = {
  "database-migration": { description: "...", grants: { extensions: [".sql"] } },
  "shell-automation":   { description: "...", grants: { extensions: [".sh"] } },
  "api-schema":         { description: "...", grants: { extensions: [".graphql", ".prisma"] } },
} as const satisfies Record<string, SkillDefinition>;

export type SkillName = keyof typeof SKILLS;
export function parseSkillName(raw: string): SkillName;      // throws on unknown (fail-closed)
export function resolveCapabilities(skills: readonly SkillName[]): Capabilities;
```

`resolveCapabilities` returns the **defaults widened by the enabled grants** — never a replacement:

```ts
{ extensions: ALLOWED_SKELETON_EXTENSIONS ∪ granted extensions,
  tools:      ALLOWED_TOOLS               ∪ granted tools }
```

Two fail-closed rules, both tested:

- an **unknown skill name is refused** (never silently ignored — ignoring it would report a grant that did
  not happen);
- a skill whose grant names a **tool outside `ALLOWED_TOOLS` is refused at catalogue-load time**, because
  this repo cannot honour such a grant. That keeps `tools` in the shape for the day a registry exists,
  without pretending it does today.

### 2. `agent/lib/dark-factory/skill-set-surface.ts` — the surface

`SkillSetSurface implements TunableSurface<readonly SkillName[]>` with `id = "skill-set"`:

- **Store-backed**: one JSON array under a fixed key, mirroring `createOperatorDecisionStore` in
  `self-improve-state.ts`. An async factory (`createSkillSetSurface(store)`) loads the snapshot once and
  caches it, because `read()` is synchronous.
- `stage(next)`: validates every name (`parseSkillName`), **canonicalises** (dedupe + sorted) so the stored
  value has one form, then mints a handle carrying `previous`/`next` and `${id}@v${n}` versions.
- `apply()` persists to the store; `revert()` restores the previous set and is **idempotent**; `isApplied()`
  answers honestly. A **superseded** handle refuses to act (`SupersededVersionError`), copying
  `IterationBoundSurface`'s optimistic-concurrency check.
- A store that refuses to persist must **not** report success — the same rule #159 learned the hard way.

### 3. A skill-specific proposal producer

`proposeSkillAddition(surface, skill, evidence)` returns an `access-widening` `Proposal` whose `hypothesis`
**must be non-empty** (the existing validator already refuses an empty one) and names the evidence. No
discovery: the operator asks for a specific skill; the factory supplies the mechanics.

### 4. Consumption — the developer agent consults the enabled set

`DeveloperAgent` takes an optional `capabilities` (defaulting to the current constants, so **existing
behaviour is unchanged when no skills are enabled**), and `applySkeletalMap`'s extension check reads it. The
proof is a test: a `.sql` file is refused by default and accepted once `database-migration` is applied and
persisted.

### 5. Where this meets #159

The headline end-to-end test: an `access-widening` skill proposal through `runImprovementCycle` is
**blocked** with `operator gate missing`; then a decision is recorded through the operator-decision store —
the exact thing #159's CLI now writes — and the same cycle **accepts and applies** it.

## Explicitly out of scope

- Autonomous discovery (the controller inventing skills) — its own issue once this surface exists.
- Granting tools — impossible until a tool registry exists; the shape is reserved, not faked.
- Wiring skills into the tester agent — the same `resolveCapabilities` seam applies; noted as a follow-up so
  this PR stays reviewable.

## Tasks (RED → GREEN, one behaviour per cycle)

| # | RED (failing test first) | GREEN |
| --- | --- | --- |
| 1 | an unknown skill name is refused by `parseSkillName`, naming it | catalogue lookup |
| 2 | a catalogue entry granting a tool outside `ALLOWED_TOOLS` is refused at load | grant validation |
| 3 | a surface over a fresh store reads an **empty** set | async factory + snapshot |
| 4 | `stage` refuses an unknown name, and nothing is persisted | validate before staging |
| 5 | `stage` canonicalises (`["b","a","a"]` ⇒ `["a","b"]`) | dedupe + sort |
| 6 | `apply()` persists; a **new** surface instance reads it back | store write/read |
| 7 | `revert()` restores the previous set, is idempotent, and `isApplied()` flips | handle restore |
| 8 | a superseded handle refuses `apply`/`revert` with `SupersededVersionError` | version assertion |
| 9 | a store that refuses to persist ⇒ refusal, never a false success | error propagation |
| 10 | `resolveCapabilities` = defaults **∪** grants (extensions), tools untouched | union, not replacement |
| 11 | `resolveCapabilities([])` equals the defaults exactly (no accidental widening) | empty-grant case |
| 12 | `proposeSkillAddition` ⇒ `kind: "access-widening"` with a non-empty hypothesis | proposal producer |
| 13 | `applySkeletalMap` refuses a `.sql` file by default and accepts it when the skill is enabled | agent consults capabilities |
| 14 | **end-to-end**: the cycle blocks the skill proposal with `operator gate missing` | existing gate |
| 15 | **end-to-end**: with a decision recorded via the operator-decision store, the cycle accepts and applies | #159 meets #157 |

## Acceptance criteria (the issue's AC8, made concrete)

- given an `access-widening` skill proposal and no armed decision, then the cycle reports
  `blocked: operator gate missing` and nothing is persisted
- given the same proposal with an armed `allow` for `("skill-set", "access-widening")`, then the cycle
  accepts it and the enabled set is persisted
- given a persisted skill, then a fresh surface instance and the developer agent both see it
- given a skill that grants a tool this repo cannot honour, then the catalogue refuses to load
- given an unknown skill name from any entry point, then it is refused with the name in the message
- given no skills enabled, then `resolveCapabilities` returns exactly today's defaults (no behaviour change)
- given a reverted grant, then the extension it added is refused again

## Files

`agent/lib/dark-factory/skills.ts` (new: catalogue + `resolveCapabilities`) ·
`agent/lib/dark-factory/skill-set-surface.ts` (new: the surface) ·
`agent/lib/dark-factory/index.ts` (exports) · `agent/lib/dark-factory/developer-agent.ts` (optional
`capabilities`, defaulting to today's constants) · `tests/dark-factory/skills.test.ts` (new) ·
`tests/dark-factory/skill-set-surface.test.ts` (new) · `README.md` · `.cspell.json` if needed.

## Validation

`npx tsc --noEmit` · full `npx vitest run` · `cspell` + `prettier` on changed files · and a **local
end-to-end run** on this laptop: arm the gate with `npm run operator -- allow skill-set --by "…"` (the #159
CLI, against a local SQLite store), then show a skill proposal moving from blocked to applied. That is the
whole feature, proved on the machine rather than asserted in a comment.

## Status

**GATE 1 — awaiting approval of this plan.** No source has been written on this branch beyond this document.
Two decisions worth a look: the **initial catalogue** (three skills, each granting one or two extensions) and
the **`read()`-is-synchronous** constraint that forces the async `createSkillSetSurface` factory.
