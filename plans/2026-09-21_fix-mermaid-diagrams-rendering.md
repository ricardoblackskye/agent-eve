# Fix Mermaid Diagram In-Place Rendering on Architecture Page

**Branch:** `fix/mermaids-diagrams` (off `origin/fix/mermaids-diagrams` = `68d177d`)  
**Type:** bug fix → `systematic-debugging` + `test-driven-development`  

## Goal

Ensure all 6 Mermaid diagrams in `ARCHITECTURE.md` (System Overview, Request Flow, Authentication Flow, Deployment Architecture, Project Structure, and Data Flow: Chat Session) are rendered **inline, directly beneath their respective section headings** using the locally installed `mermaid` package, eliminating external CDN dependencies, race conditions, and displacement to the bottom of the page.

---

## Root Cause Analysis (Verified in Code)

Inspection of `app/architecture/page.tsx` revealed two distinct structural defects:

### 1. Diagram Extraction and Section Displacement
```typescript
// app/architecture/page.tsx lines 24-31
const processed = md.replace(
  /```mermaid\s*\n([\s\S]*?)```/g,
  (_match, code: string) => {
    const id = `mm-${i++}`;
    blocks.push({ id, code: code.trim() });
    return `<MermaidPlaceholder id="${id}" />`;
  },
);
```
And lines 114–124:
```tsx
<ReactMarkdown ...>
  {content.replace(/<MermaidPlaceholder id="([^"]+)" \/>/g, " ")}
</ReactMarkdown>

{mermaidBlocks.map((block) => (
  <div className="mermaid-wrapper" key={block.id}>
    <pre className="mermaid" id={block.id}>{block.code}</pre>
  </div>
))}
```
* The regex strips all Mermaid code blocks out of their original positions within the markdown sections and replaces them with whitespace `" "`.
* The diagrams are then dumped into a flat list at the very bottom of the page (`{mermaidBlocks.map(...)}`).
* Underneath the section headings (*System Overview*, *Request Flow*, *Authentication Flow*, *Deployment Architecture*, *Project Structure*, and *Data Flow: Chat Session*), nothing is rendered.

### 2. Asynchronous Script Loader Race Condition
```typescript
// app/architecture/page.tsx lines 38-56
const script = document.createElement("script");
script.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
script.onload = () => {
  (window as any).mermaid.initialize({ ... });
};
document.head.appendChild(script);

// lines 60-77
useEffect(() => {
  if (mermaidBlocks.length > 0 && (window as any).mermaid) {
    // calls (window as any).mermaid.run({ nodes: [el] })
  }
}, [mermaidBlocks]);
```
* The second `useEffect` executes immediately when `mermaidBlocks` state is populated. At that instant, the CDN script tag has just been injected and is still downloading over the network. Therefore, `(window as any).mermaid` is `undefined` and the `if` check evaluates to `false`.
* When the CDN script finishes downloading, `script.onload` initializes configuration but never invokes `mermaid.run()` and does not update React state.
* Because `mermaidBlocks` never updates again, the second `useEffect` never fires again, leaving the diagrams as raw unrendered text.
* Furthermore, `package.json` already includes `"mermaid": "^11.17.2"` locally, making the external CDN script download completely redundant and brittle.

### 3. False Positive in Existing E2E Test
`e2e/architecture.spec.ts` had:
```typescript
test("renders Mermaid diagrams on the page", async ({ page }) => {
  await page.goto("/architecture");
  await expect(page.locator("svg")).toBeVisible({ timeout: 15_000 });
});
```
`page.locator("svg")` matched the Next.js development server status/toast indicator icon, masking the fact that 0 Mermaid SVGs had been rendered.

---

## Design Decisions

1. **Inline Component-Based Rendering via `ReactMarkdown` Custom Component**:
   * Do not preprocess or regex-strip the raw markdown.
   * Provide a custom `code` component to `ReactMarkdown` that matches language `language-mermaid` and renders an inline `<MermaidDiagram code={...} />`.
   * Unwrap `<pre>` when enclosing a Mermaid diagram to avoid duplicate wrappers and pre-formatting conflicts.
2. **Use Bundled `mermaid` via Dynamic Import**:
   * Use `import("mermaid")` inside `<MermaidDiagram />` (client component).
   * Call `mermaid.render(id, code)` to generate SVG strings safely and insert them with `.mermaid-wrapper` styling.
   * Remove all dynamic `<script src="https://cdn.jsdelivr.net...">` tags from `document.head`.
3. **Strict End-to-End TDD Test**:
   * Enhance `e2e/architecture.spec.ts` to assert:
     * Exactly 6 `.mermaid-wrapper svg` elements exist on the page.
     * Each of the 6 sections has a rendered SVG element located between its heading and the subsequent heading.
     * No raw `graph TB` or `sequenceDiagram` strings remain visible as unrendered text.

---

## Tasks (TDD, vertical tracer bullets)

| # | RED (Failing Test First) | GREEN (Implementation) | AC |
|---|---|---|---|
| **1** | Write strict E2E assertions in `e2e/architecture.spec.ts` for all 6 diagrams located within their respective sections | Run `npx playwright test e2e/architecture.spec.ts` and verify it **FAILS** with missing SVGs in section blocks | Reproduce failure cleanly under test runner |
| **2** | Create `<MermaidDiagram />` inline component using local `mermaid` library | Implement `app/architecture/mermaid-diagram.tsx` with dynamic `import("mermaid")` and `mermaid.render` | Component renders SVG from diagram text without CDN script |
| **3** | Update `app/architecture/page.tsx` to render markdown directly with custom `code` & `pre` renderers | Replace extraction regex and CDN script loader with direct `<MermaidDiagram />` in `ReactMarkdown` | All 6 diagrams render in-place under their respective headings |
| **4** | Run E2E test suite and verify all tests pass | Run `npx playwright test` | All tests pass, 6/6 diagrams rendered, no raw text |
| **5** | Typecheck and Build Validation | Run `npm run typecheck` and `npm run eve:build` | Zero TypeScript errors, clean production bundle |

---

## Detailed Steps

### Task 1: Write the Failing E2E Tests (RED)
**Files:**
- Modify: `e2e/architecture.spec.ts`

Add assertions checking:
1. `expect(page.locator(".mermaid-wrapper svg")).toHaveCount(6)`
2. For each section heading (`System Overview`, `Request Flow`, `Authentication Flow`, `Deployment Architecture`, `Project Structure`, `Data Flow: Chat Session`), verify that a `.mermaid-wrapper svg` is present prior to the next heading.
3. Verify no raw unrendered mermaid definitions appear in page text.

Run: `npx playwright test e2e/architecture.spec.ts`  
Expected result: **FAIL** (currently 0 `.mermaid-wrapper svg` exist).

---

### Task 2: Create Inline Mermaid Component (GREEN step 1)
**Files:**
- Create: `app/architecture/mermaid-diagram.tsx`

```tsx
"use client";

import { useEffect, useState } from "react";

interface MermaidDiagramProps {
  code: string;
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        themeVariables: {
          fontFamily: "system-ui, -apple-system, sans-serif",
          primaryColor: "#1a3a5c",
          primaryTextColor: "#e5e5e5",
          primaryBorderColor: "#4a8ad4",
          lineColor: "#666",
          secondaryColor: "#1a1a2e",
          tertiaryColor: "#2d2d2d",
        },
      });

      const uniqueId = `mm-${Math.random().toString(36).substring(2, 9)}`;
      mermaid
        .render(uniqueId, code.trim())
        .then(({ svg }) => {
          if (isMounted) {
            setSvg(svg);
          }
        })
        .catch((err) => {
          console.error("Mermaid render error:", err);
          if (isMounted) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    });

    return () => {
      isMounted = false;
    };
  }, [code]);

  if (error) {
    return (
      <div className="mermaid-wrapper mermaid-error">
        <pre className="mermaid">{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="mermaid-wrapper mermaid-loading">
        <pre className="mermaid">{code}</pre>
      </div>
    );
  }

  return (
    <div
      className="mermaid-wrapper"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
```

---

### Task 3: Refactor Architecture Page to Render In-Place (GREEN step 2)
**Files:**
- Modify: `app/architecture/page.tsx`

1. Remove regex splitting and state tracking (`mermaidBlocks`, `mermaidLoaded`).
2. Remove `<script>` tag creation.
3. In `<ReactMarkdown>`:
   * Match `className="language-mermaid"` in `code` component.
   * Return `<MermaidDiagram code={String(children)} />`.
   * In `pre` component, return plain children if child is `language-mermaid`.
4. Remove the trailing `{mermaidBlocks.map(...)}`.

---

### Task 4: Run E2E Tests to Verify PASS (GREEN verification)
Run: `npx playwright test e2e/architecture.spec.ts`  
Expected result: **PASS** with all 6 diagrams rendered in their respective sections.

Run full test suite: `npx playwright test`  
Expected result: **10/10 tests pass**.

---

### Task 5: Build & Typecheck
Run: `npm run typecheck`  
Run: `npm run build` / `npm run eve:build`  
Expected result: 0 errors.

---

## Files Changed
- `e2e/architecture.spec.ts` (test enhancements)
- `app/architecture/mermaid-diagram.tsx` (new component)
- `app/architecture/page.tsx` (inline rendering refactor)
- `next.config.ts` (`allowedDevOrigins` preservation)

---

## Validation
- `npx playwright test e2e/architecture.spec.ts` passes with 6 SVG checks and heading adjacency checks.
- Full E2E suite passes (`npx playwright test`).
- Typecheck clean (`npm run typecheck`).
- Visual verification in browser at `http://127.0.0.1:3000/architecture`.

---

## Status
**GATE 1 — awaiting plan approval.**
