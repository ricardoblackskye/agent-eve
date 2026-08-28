# #21 — /releasenotes Page

**Issue:** #21
**Branch:** `feat/releasenotes-page`

## Goal

Add a browsable `/releasenotes` page that renders `releasenotes.md` as styled HTML — exactly the same pattern as `/architecture` but simpler (no Mermaid handling needed).

## Files

| File                            | Action     | What it does                                                  |
| ------------------------------- | ---------- | ------------------------------------------------------------- |
| `app/api/releasenotes/route.ts` | **Create** | Serves `releasenotes.md` content (or placeholder) via `GET`   |
| `app/releasenotes/page.tsx`     | **Create** | Client component, fetches markdown, renders via ReactMarkdown |
| `releasenotes.md`               | **Create** | Empty placeholder file with initial heading                   |
| `e2e/releasenotes.spec.ts`      | **Create** | Playwright tests for the page                                 |
| `app/globals.css`               | **Modify** | Reuse `.architecture-container` styles (no new CSS needed)    |

## Implementation

### 1. API Route — `app/api/releasenotes/route.ts`

Same pattern as `/api/architecture`:

- Reads `releasenotes.md` from project root
- Returns markdown as `text/markdown`
- If file doesn't exist, returns a placeholder: `"# Release Notes\n\nNo release notes yet."`

### 2. Page — `app/releasenotes/page.tsx`

Simplified version of the architecture page:

- Fetch markdown from `/api/releasenotes`
- Render with `ReactMarkdown` + `remarkGfm`
- No Mermaid extraction/loading (release notes are plain markdown)
- Same `.architecture-container` CSS class for consistent styling
- Title metadata: "Release Notes — Eve Agent"

### 3. Placeholder file — `releasenotes.md`

Create an empty initial file:

```markdown
# Release Notes
```

### 4. E2E Tests — `e2e/releasenotes.spec.ts`

- `loads the release notes page` — page title, heading visible
- `shows placeholder content when no releases exist` — displays the initial heading
- `contains the page header` — "Release Notes" heading is present

## TDD Workflow

```
Phase 2: Write E2E test → verify RED (page doesn't exist yet)
Phase 3: User gate → wait for approval
Phase 4: Implement all files → verify GREEN
```

## Verification

```bash
npm run typecheck
npm run build       # Should show /releasenotes and /api/releasenotes
npm run dev
curl http://localhost:3000/api/releasenotes    # Returns markdown
curl http://localhost:3000/releasenotes        # Renders page
npx eve eval --strict --url http://localhost:3000  # No regressions
```
