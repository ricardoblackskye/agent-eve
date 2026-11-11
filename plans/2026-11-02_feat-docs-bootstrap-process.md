# Plan: Reusable documentation-bootstrap process for AMM-linked repos (#576)

- **Issue:** #576
- **Branch:** feat/docs-bootstrap-576
- **Status:** Draft (awaiting plan approval / GATE)
- **Approach:** TDD, AI SDLC (RED-GREEN-REFACTOR)

## Goal
Turn the agent-eve documentation convention (docs/adr + docs/pages) into a reusable
`docs-bootstrap` capability in the AMM toolchain, so any repository linked or scanned by the
AMM can be seeded with the convention instead of relying on a static ARCHITECTURE.md.

## Release split
- **Release 1 (this branch):** manual `npm run df:amm-docs-bootstrap -- --repo owner/repo --workspace <dir>`
  command that scaffolds the convention into a target repo and opens a PR. Validated on WebFeedPOC first.
- **Release 2 (follow-up):** automatic trigger after an AMM scan of a newly-linked repo.

## Repo-type detection (decision from #576 discussion)
The bootstrap inspects the target repo and applies the right approach:
- **Next.js / render-time repos** (detect `next.config.*`, `next` in deps): seed `docs/pages` AND a
  render-time generator so reference pages stay drift-free (agent-eve ADR #0012 behaviour).
- **Other repos:** seed static `docs/pages/*.md` + an optional generator script, plus the
  ARCHITECTURE.md -> pointer conversion.

## Artifact seeded into the target repo
- `docs/adr/README.md` + `docs/adr/template.md` - vendored from agent-eve (single source of truth).
- `docs/adr/0001-<repo>-adopts-docs-tree.md` - first ADR, recorded at adoption time.
- `docs/pages/README.md` + `docs/pages/overview.md` - skeleton (render-aware for Next, static otherwise).
- `ARCHITECTURE.md` - trimmed to a pointer to `docs/pages/overview.md`.

## Implementation (Release 1)
1. **Template source** - add `docs/_bootstrap/` (or `scripts/bootstrap-docs-templates/`) in agent-eve
   holding the canonical ADR README, ADR template, and a starter `docs/pages` skeleton.
2. **Command** - `scripts/docs-bootstrap.ts` (run via `npm run df:amm-docs-bootstrap`):
   - parse `--repo`, `--workspace`, optional `--type` (auto-detected if omitted);
   - detect repo type (next.config / deps);
   - render the artifact from the template dir into the target workspace;
   - open a PR via the GitHub provider (reuse existing PR-creation seam; no direct push).
3. **Tests (TDD)** - `tests/docs-bootstrap.test.ts`:
   - given a fake workspace with no `docs/adr`, assert the tree + ADR #0001 + ARCHITECTURE.md pointer are produced;
   - assert seeded README/template equal the vendored source (no divergence);
   - assert idempotency (re-run is a no-op);
   - assert Next vs non-Next selection paths.
4. **CLI wiring** - add `df:amm-docs-bootstrap` to package.json scripts and to the AMM command catalogue (ADR #0053).

## Acceptance criteria
- Command run on WebFeedPOC creates the docs tree + ADR #0001 + ARCHITECTURE.md pointer in a PR.
- Seeded README/template byte-match agent-eve's vendored copies.
- Re-run on an already-bootstrapped repo is a no-op or updates gracefully.

## Out of scope (Release 2)
Automatic trigger after AMM scan; per-repo opt-in/opt-out.

## Risks / notes
- The render-time generator is agent-eve-specific; for non-Next repos we seed static markdown + optional script.
- Target repos have branch protection, so the bootstrap opens a PR, never pushes directly.
