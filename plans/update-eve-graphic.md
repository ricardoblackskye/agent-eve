# Update Eve Graphic

**Issue:** #12
**Branch:** `feat/update-eve-graphic`

## Changes

### 1. Replace Avatar Image
Replace `public/images/eve-avatar.jpg` with the new character graphic from the issue. Test

**Image source:** https://github.com/user-attachments/assets/7862c9d2-34c6-453c-953c-05fe9bcdf4a8

### 2. Enlarge Avatar to 150×150px
- `app/chat.tsx` — change `width={40} height={40}` → `width={150} height={150}`
- `app/globals.css` — change `.eve-avatar` width/height from 40px → 150px

### 3. Capitalise "Ready" Status
- `app/chat.tsx` — change `{agent.status}` → `{agent.status === "ready" ? "Ready" : agent.status}` so it displays with correct casing

### 4. Green Background for "Ready" Status
- `app/globals.css` — add `.status.ready { background: #1a5; }` so the ready state shows green

## Test Plan

### Tests to Update (e2e/chat.spec.ts)

| Line | Current Assertion | New Assertion | Reason |
|------|-------------------|---------------|--------|
| 10 | `.status` has text "ready" | `.status` has text **"Ready"** | Casing fix |
| 19 | `.status` has text "ready" | `.status` has text **"Ready"** | Casing fix |
| 52 | `.status` has text "ready" | `.status` has text **"Ready"** | Casing fix |
| 83–85 | avatar `width=40` | avatar `width=**150**` | Size change |
| — (new) | — | `.status.ready` has green background color | Green styling |

### Tests Not Affected
- `evals/frontend.eval.ts` — checks for "Eve Agent" heading (unchanged)
- `evals/model-check.eval.ts` — model assertion (unchanged)
- `e2e: "displays 'Eve' label"` — unchanged
- `e2e: "uses the browser proxy health endpoint"` — unchanged logic, only status text assertion updated

## TDD Workflow

```
Phase 2: Update tests to expect new behaviour → verify RED
Phase 3: USER GATE → wait for approval
Phase 4: Implement all changes → verify GREEN
Phase 4.5: TypeScript + build check
```

## Definition of Done
- [ ] Avatar image replaced with new graphic
- [ ] Avatar is 150×150px in header
- [ ] Status text shows "Ready" (capitalised)
- [ ] `.status.ready` has green background
- [ ] All existing Playwright tests pass (with updated assertions)
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
