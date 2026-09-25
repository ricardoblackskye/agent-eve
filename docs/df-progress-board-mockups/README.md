# Dark Factory progress-board mockups — issue #178

These are **three disposable layout explorations**, not production UI or a locked visual design. All displayed run IDs, counts, costs, durations, and timestamps are illustrative sample data; they are not live metrics.

## Variants

| Variant | Layout / visual stance | Strength | Trade-off |
|---|---|---|---|
| `01-compact-dark.html` | Compact dark console with top tabs | Strong scan density and an unobtrusive operator feel | Less breathing room; weaker at-a-glance hierarchy |
| `02-airy-editorial.html` | Light, spacious cards with a persistent sidebar | Readable, approachable overview; clear section hierarchy | More vertical space and less visible data at once |
| `03-operator-split.html` | Dense dark workbench with icon rail and split panes | Keeps run list and selected-run context close together | Most tool-like; denser and more demanding for occasional viewers |

Each variant includes **Overview**, **Run table**, and **Run detail** screens, with clickable navigation and a working search/filter interaction. The content follows issue #178: outcome categories, filterable run history, lifecycle timeline, worker progress, measured metrics, and issue/PR links. Refresh is represented as periodic/polling rather than realtime.

## Raster previews

See `renders/` for nine full-screen PNGs (three screens × three variants) and `contact-sheet.png` for a side-by-side comparison. The HTML files remain the editable source of the wireframes.

Open an individual mockup in a browser, or open `renders/contact-sheet.png` first to compare the overall directions. No build step or external service is required to view the HTML.

To regenerate the PNGs on this machine, run `node render.cjs` (local Edge + Playwright) and then `python make_contact_sheet.py` (Pillow). The render scripts do not contact external services.
