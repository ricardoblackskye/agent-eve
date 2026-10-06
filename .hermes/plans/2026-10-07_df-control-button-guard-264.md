# Plan — #264 Run Management logic fixes (control-button visibility)

Sub-issue of #262 (run-details). Branch `fix/df-control-button-guard-264`, based on `origin/main` @ `516db78` (post-#262 merge).

## Problem

`ControlPanel` (`app/dark-factory/ui/control-panel.tsx`) derives button visibility from the **control state** only:

- `stopped = isRun && run?.stopped === true` (control-panel.tsx:39)
- if `!stopped`: render Pause/Resume toggle + "Stop run"; if `stopped`: render "Stopped — cannot resume".

`RunControlState` (`agent/lib/dark-factory/control.ts:15-21`) exposes only `paused`/`stopped` — **no lifecycle `status`**. A terminal run (status `succeeded`/`failed`) has `stopped === false` (the `stopped` flag is set only by an explicit stop action, not by a terminal run event), so a succeeded/failed run still renders the toggle **and** Stop. Reported by the user:

- Failed run shows "Resume run" + "Stop run" → should show "Resume run" only (resume = start a new run).
- Succeeded run shows both → should show neither (terminal success).

The run lifecycle `status` (`RunSummary.status`/`stage`, from `queryRunDetail`) is already available in the page (`app/dark-factory/runs/[runId]/page.tsx` receives both the run summary and the control state) but is not threaded into `ControlPanel`.

## Approach

Thread the run lifecycle `status` into `ControlPanel` and gate visibility on it (replacing the `stopped`-only check). No store / control-service change is required for the visibility fix — the control actions (pause/resume/stop) already exist.

Visibility matrix (by `RunSummary.status`):

| status    | toggle label | "Stop run" | notes |
|-----------|---------------|------------|-------|
| running   | "Pause run"   | yes        | active |
| paused    | "Resume run"  | yes        | active (manual pause) |
| failed    | "Resume run"  | no         | terminal; resume starts a new run |
| succeeded | (none)        | no         | terminal success; show "Succeeded" label |
| stopped   | (none)        | no         | already stopped; show "Stopped" label |

`queued`/`blocked` are left unchanged unless flagged.

The "Resume run" on a failed run must remain actionable (start a new run). `performControlAction` currently resumes a paused run; resume-on-failed (restart) is a back-end consideration — flagged in review (if unsupported it becomes a follow-up; the button visibility is the reported defect).

## TDD

- **T1 (RED→GREEN)** — `tests/dark-factory-ui/run-detail-page.test.tsx`: a `failed` run (`RunSummary.status === "failed"`, control `run` empty) renders "Resume run" and does **not** render "Stop run". Current code shows Stop → RED. GREEN after `ControlPanel` gates "Stop run" on lifecycle status (terminal → no Stop).
- **T2** — visibility matrix: running→Pause+Stop, paused→Resume+Stop, failed→Resume only, succeeded→neither, stopped→neither.
- **Fix existing T3** (`run-detail-page.test.tsx:124`): its `SUMMARY` stub uses `status:"succeeded"` + control `run:{paused:true}`. Under the new logic a succeeded run shows neither, which breaks T3. Change the stub `status` to `"paused"` so the "Resume run"+"Stop run" happy-path assertion is valid for a paused run.
- **Regression**: `npm run test` (run-detail-page + control-panel) green; `tsc --noEmit`; `npm run build`; cspell clean.

## Out of scope

- £/currency formatting (separate follow-up).
- Resume-on-failed back-end restart semantics (flagged; follow-up if unsupported).

## Branch / PR

Branch `fix/df-control-button-guard-264` from `origin/main`. PR to be opened after TDD, with user go-ahead; GitHub Checks must be green.
