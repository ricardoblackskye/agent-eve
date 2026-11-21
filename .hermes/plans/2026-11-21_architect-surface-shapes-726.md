# 726 - a surface is derived from composition, not from framework conventions

**Goal:** a page-scoped story resolves its surface in any reasonable project shape, so a new repository is
usable by the factory without first being Next.js-shaped. The refusal to guess **stays**: a run must never
invent a target.

## Root cause (verified, two gates)

Observed on `ricardoblackskye/local-promotion-site` #11, a Vite/React SPA:

```text
[STEP 3] Architect Agent discovering repository structure and planning story...
[ERROR] Planning failed, so this run stopped before writing any code.

The story is scoped to one page, but no page could be identified in the repository, so no target can be
justified. A human needs to name the surface.
```

The story was not vague - it said *"Add a 'Welcome to my site' to the bottom of the main page"*.

**A second run parked identically**, and it is the more telling one: issue #12 said *"Add a 'Welcome to my
site' to the bottom of the `src/pages/BlogPostPage.ts` page below all other content"* - **naming the file
outright** - and the Architect still could not justify a target. A story that names an existing path in the
repository is the cheapest case there is, and it failed too.

**Gate 1 - discovery.** `agent/lib/dark-factory/architect-discovery.ts` states its own doctrine at the top:

> a role is derived from what a file DOES (its contents and who reaches it), **never from its name**

and then contradicts it. The route-to-page map (`pageForRoute`, used at `:301-304`) is populated from
Next-shaped constants - `NEXT_PAGE = /(^|\/)app\/(?:.*\/)?page\.(?:jsx?|tsx?)$/i` and `NEXT_LAYOUT`
(`:47-48`). A Vite SPA has no `app/**/page.tsx`, so the map is empty, `DEFAULT_SURFACE_WORDS` cannot resolve
`"/"`, and `surface.page` is undefined (`:329-330`). `App.tsx` IS read (discovery priority `:63` matches
`app`), but is classified `shell` - a role the module defines - and a shell is deliberately not a page.

**Gate 2 - validation.** `agent/lib/dark-factory/plan-validator.ts:370-382` requires a UI story's targets to
start with `app/`, `src/app/` or `components/`:

```text
UI/Chat story must modify or create files under app/ or components/ (e.g. app/page.tsx or app/chat.tsx).
```

A Vite SPA's page is `src/pages/*.tsx`, so even once the surface resolves, the plan would be refused. Fixing
only gate 1 moves the park, it does not remove it.

## Intended fix

**Derive the surface from the router's own declaration - the composition - which is what the module already
does for every other role.** A route table states, in the repository's own words, which component renders a
path. That is evidence, not convention, and it works for any shape that declares its routes: React Router,
Vue Router, SvelteKit, Remix, Astro.

**A path the story names, and which exists in the repository, IS the surface.** This is the most
mechanical rule available and the one the two parked runs point at: #12 named `src/pages/BlogPostPage.ts`
and still resolved nothing. It costs no framework knowledge at all, and it covers every shape - including
the ones with no recognizable convention. Where a story names a path that does not exist, that is a
different, named outcome (the file is not there), not "no page could be identified".

**Make gate 2 mechanical.** The rule should be "does this path exist in the repository", not "does it start
with one of three framework prefixes". The repository already has this precedent: a prompt rule that asked
for entrypoints under `app/` was replaced by a mechanical existence check that yields a `target-missing`
error naming the path (the prompt is advice, the validator is enforcement).

Deliberately NOT in scope: teaching the detector every framework's conventions one by one. A per-framework
branch list is the same defect with more entries - it is what makes a new repository a code change.

## Tasks (TDD)

### Task 1 - the route table resolves a surface

- Modify: `agent/lib/dark-factory/architect-discovery.ts`
- Test: `tests/dark-factory/architect-discovery*.test.ts`

**Step 1 (RED).** A fixture repository shaped like this one - a router declaring `"/"` to a component under
`src/pages/` - resolves `surface.page` to that component. First case, because it needs no framework
knowledge: a story whose text names a path that exists resolves to that path (#12's failure). Cases: a router table mapping `/` to a page; a
router table mapping a named path; a repository with no route table (undefined, unchanged); and a CONTROL
asserting a Next-shaped fixture still resolves, so this widens rather than replaces.

**Step 2 (GREEN).** Derive the map from the router's declaration, keeping `NEXT_PAGE` behaviour.

### Task 2 - the validator checks existence, not prefixes

- Modify: `agent/lib/dark-factory/plan-validator.ts`
- Test: the plan-validator's existing suite

**Step 1 (RED).** A UI story targeting `src/pages/BlogPostPage.tsx` in a repository where that path exists
validates. A UI story targeting a path that does NOT exist is still refused, naming the path - the control
that proves the rule was tightened, not dropped.

**Step 2 (GREEN).** Replace the prefix allow-list with the existence check.

### Task 3 - docs and ADR

- Create: `docs/adr/0094-a-surface-is-derived-from-composition.md`
- Modify: `docs/adr/README.md` (index row) and the page owning the Architect

The ADR records why the map is built from the router's own declaration rather than framework conventions, and
why the validator checks existence: a convention list turns a new repository into a code change.

## Files likely to change

| Path                                                     | Change                                        |
|:---------------------------------------------------------|:----------------------------------------------|
| `agent/lib/dark-factory/architect-discovery.ts`          | derive the route-to-page map from the router  |
| `agent/lib/dark-factory/plan-validator.ts`               | existence check instead of framework prefixes |
| `tests/dark-factory/`                                    | one fixture per shape named in #726           |
| `docs/adr/0094-a-surface-is-derived-from-composition.md` | the decision                                  |
| `docs/pages/` + `docs/adr/README.md`                     | module page and index row                     |

## Validation

1. `npx vitest run tests/dark-factory` - the discovery and validator suites.
2. `npx tsc --noEmit --incremental false` - clean.
3. `npm run coverage:ratchet` - no drop.
4. cspell, markdownlint (MD040/MD026/MD047), the pinned markdown-table-formatter, and markdown-link-check on
   every changed `.md`.
5. **A live run against `ricardoblackskye/local-promotion-site` #11** - the case that failed - must resolve a
   surface and proceed past STEP 3. This is the only proof that counts, and the image for that repository is
   already built and loaded into the cluster.

## Risks / open questions

- **How far to generalize the route-table parser.** Starting with the shapes that declare routes in a file the
  discovery already reads (`App.tsx` is read today, at priority 1) keeps it bounded. A repository that declares
  routes dynamically cannot be resolved this way, and should keep parking - with a named reason, not a generic
  one.
- **The `shell` role.** `App.tsx` is correctly a shell; the fix is that a shell may *contain* the route table
  that names a page, not that a shell becomes a page.
- **Gate 2's blast radius.** The existence check is stricter than "starts with app/" in one way and looser in
  another: it accepts `src/pages/` and rejects an invented `src/components/Whatever.tsx`. That is the intended
  direction.
