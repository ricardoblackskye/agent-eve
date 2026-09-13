# Dark Factory — Delivery Loop · Diagram Generator Prompt

> Repo: `ricardoblackskye/agent-eve` · Branch: `docs/dark-factory-plan-127`
> Use: paste this prompt into an image-capable model (e.g. Gemini) to (re)generate the
> `dark-factory-loop.png` wiki diagram. Re-run it whenever the architecture changes.

---

Create a clean, professional flowchart diagram titled **"Dark Factory — Delivery Loop"**.

**STYLE:** Dark theme (background near-black `#020617`, subtle 40px grid), subtle flat
neon colors for boxes, thin connectors with arrowheads, small console-style font for
tool names, clean left-to-right and top-to-bottom reading order, generous spacing so no
arrow crosses a box or overlaps text. No 3D, no heavy gradients, no clutter.

**CONTEXT:** This diagrams an automated software-delivery "dark factory" where an
orchestrator (Eve) dispatches work to worker agents running in sandboxed containers, uses
an async queue, and self-corrects on CI failure. Lay it out in 3 horizontal bands (top
delivery row, middle CI row, bottom control row) as described below.

## LAYOUT (3 bands, left to right)

### TOP BAND (the delivery flow)
- **PBI / Issue** box — grey border — label badge `INPUT`
  - body: task + skeletal file map
- **QStash** box — orange — label badge `QUEUE`
  - body: bounded retry / backoff
- **Developer Agent** box — emerald/green — label badge `THE DOER`
  - body: writes code + unit tests
  - tools: `git_clone read_file` / `write_code run_tests`
- **Tester Agent** box — cyan — label badge `THE GUARD`
  - body: validates before PR
  - tools: `static analysis | smoke` / `security scan`
- **PASS?** box — violet — decision/diamond shape
  - body: exit code 0

### MIDDLE BAND
- **Submit Pull Request** — amber — label badge `GATEWAY` — body: Eve = quality gate
- **CI / CD** — amber — label badge `PIPELINE` — body: build | unit | deploy
- **Ships** — green — body: automated

### BOTTOM BAND (control / support)
- **Eve — Orchestrator** — rose/red — label badge `SELF-CORRECT`
  - body: interprets CI failure / routes back | owns state
- **Observability** — violet — label badge `METRICS`
  - body: iterations | fix-cycles / success rate
- **Circuit breaker** — rose/red — label badge `GUARDRAIL`
  - body: worker-min budget / human escalation

## CONNECTIONS (arrowheads; these are the ONLY edges — do not add others)

1. PBI / Issue → QStash — label `dispatch`
2. QStash → Developer — label `async trigger` (dashed)
3. Developer → Tester — label `code + tests`
4. Tester → PASS?
5. PASS? → down to Submit Pull Request — label `yes`
6. PASS? → back over to Developer — label `no — iterate (bounded)` (dashed, curves back)
7. Submit Pull Request → CI / CD
8. CI / CD → Ships — label `pass`
9. CI / CD → Eve — Orchestrator — label `CI failure event` (dashed, goes down)
10. Eve — Orchestrator → Developer — label `route back (fix defect)` (dashed loop back up)
11. Developer → Observability — label `metrics` (dashed)
12. Tester → Observability — label `metrics` (dashed)
13. Circuit breaker → QStash — label `budget gate` (dashed)

## LEGEND (bottom)
- solid emerald = Worker (Developer)
- solid cyan = Worker (Tester)
- dashed orange = Async queue (QStash)
- dashed rose = Corrective loop / guardrail
- dashed violet = Observability / metrics

## COLOR CODE (so meaning is distinguishable)
- grey = input · orange = async queue · emerald = developer/release · cyan = tester ·
  amber = gateway/pipeline · violet = decision/metrics · rose = correction/guardrail

## OUTPUT
A single clean diagram image, dark background, high quality, all text readable, no
overlapping elements, ready to embed in a technical wiki page.

## PLACEMENT HINTS (if your first pass overlaps)
- Place **PASS?** slightly below-centre so its `yes` arrow drops cleanly and the `no`
  arrow can curve back over the top row without crossing "Developer Agent" or "Tester".
- Keep `route back (fix defect)` (edge 10) outside the top-band boxes by routing it up
  the left and over the top, or behind the row.