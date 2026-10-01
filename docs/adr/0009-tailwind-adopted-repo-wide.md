# 0009 — Tailwind is adopted repo-wide, as the single styling method

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

Documentation pages needed a styling approach that suits rendered markdown —
headings, lists, tables and code blocks. Hand-writing that CSS was one option;
adopting Tailwind was the other, and it brings `@tailwindcss/typography`, whose
`prose` class exists for exactly that job.

The concern was Tailwind's **Preflight**, which resets margins, headings, lists
and borders globally and would therefore touch every existing page. Measurement
before deciding changed the picture:

- The app has **7** styled pages and `app/globals.css` carries 97 class selectors.
- `globals.css` already begins with `* { box-sizing: border-box; margin: 0;
  padding: 0 }`, so Preflight's margin and box-sizing resets are largely a no-op.
- The app defines **no** `h1`-`h6`, `p`, `ul` or `li` rules — it relied on browser
  defaults. Preflight *does* override those, so headings would have flattened to
  body text and lists would have lost their markers on every page.

## Decision

Adopt Tailwind **repo-wide** as the single global styling method, and restore the
two things Preflight would otherwise remove — heading sizes/weights and list
markers — explicitly in `globals.css`.

The end state is **one** styling method. The 97 existing selectors are not
migrated in this change; that migration is a deliberate follow-on tracked as its
own issue, because mixing Tailwind utilities and hand-written selectors
indefinitely is the outcome this decision exists to avoid.

## Consequences

- Documentation pages can use utility classes and `prose` immediately, and new
  work has one obvious styling method rather than two.
- The app's appearance is preserved by explicit rules rather than by luck: the
  heading and list declarations in `globals.css` are load-bearing, and a
  structural test fails if any heading level loses its `font-size`.
- Rules declared outside a layer in `globals.css` beat Tailwind's layered ones, so
  existing selectors keep winning where they overlap. That precedence is what makes
  the incremental migration possible.
- **Residual risk:** Preflight also sets `html { line-height: 1.5 }` and
  `border-style: solid; border-width: 0`. Neither was restored here. If a page
  shifts, that is where to look — the visual check is the gate, not the unit
  suite.
- Two styling systems coexist until the follow-on migration lands. That window is
  intended to be finite.
