# #404 R2 — what a run leaves behind when it stops without finishing

**Issue:** #404 · **Branch:** `feat/df-run-leftovers-404` · **Base:** `9a6935d` (R1 merged via PR #407)

**Goal.** R1 made a local run a single command. R2 closes the loop the acceptance run exposed: a run that stops
without finishing leaves the ledger holding its issue's claim, and there is **no in-repo way to release it**, so a
clean re-run is refused. The live evidence, verbatim from the R1 acceptance:

> `the ledger already holds an active run (38e52448-…, status 'blocked') for ricardoblackskye/webfeedpoc#169, so this
> attempt was not recorded. This run will not start: wait for that run to finish, or retire its claim if the process
> is gone.`

The only way through was dropping the scratch database. The same event also leaves the ticket wearing a lifecycle
label that reads as a live run. Retiring a claim and reconciling the label are one problem — *what a run leaves
behind* — so they are one release.

## The decision that matters most

**Retiring a claim means ABANDONING the run, not deleting its record and not merely releasing a lock.**

ADR 0026 makes the claim atomic: one active run per repo+issue. A parked run is legitimately *active* — it resumes
when a human answers (ADR 0041/0022). So if retirement merely released the claim, the parked run could later resume
and there would be two agents on one issue — the exact thing the claim exists to prevent.

Therefore retirement is a **terminal transition**: the run is marked retired (with a reason and who did it), *then*
the claim is released. The ledger keeps the history and still explains why the run stopped; the ticket stops
claiming to be busy.

## Decisions

1. **A named operation, never a row delete.** "Retire its claim" must be a deliberate, recorded act: the run gains a
   terminal state and a reason; nothing is erased.
2. **Fail-closed about a LIVE holder.** A run whose status is `running` is refused — an in-flight process must never
   be cut out from under itself. A `blocked` (parked) run may be retired precisely because it is a wait, not work;
   retirement is what makes it unable to resume.
3. **One truth.** The run keeps its own vocabulary (a terminal retirement status plus a reason), so the ledger never
   grows a second story about the same run.
4. **The label is reconciled by the same operation.** A run that died outside its lifecycle leaves the factory's own
   label behind; retirement reconciles it and reports the state the ticket is left in. Only the factory's labels are
   touched.
5. **The launcher names the fix.** Its claim refusal must print the retire command with the holder's id, so the
   observed message — "wait, or retire it if the process is gone" — becomes an action rather than advice. This wires
   the preflight's claim probe (built and tested in R1, deliberately left unwired until now).

## Tasks

Each is a RED/GREEN pair as separate commits.

| # | task | notes |
|---|---|---|
| 1 | `retireRunClaim` on the run-history store: refuse when the holder is `running`; otherwise mark the run retired with a reason and release the claim | the store owns the atomicity — read the holder and the transition in one place |
| 2 | The retirement is recorded and visible: the run's history still explains why it stopped | assert the RECORD, not just the released claim |
| 3 | Label reconciliation: clear the factory's running label, report the state the ticket is left in, never touch a foreign label | |
| 4 | `npm run df:retire-claim -- --repo <owner/repo> --issue <n> [--reason <text>]`: names the holder before acting and prints exactly what changed | one line, like the launcher |
| 5 | The launcher wires the claim probe and names the retire command in its refusal | closes the loop the E2E exposed |
| 6 | Docs: extend `docs/pages/dark-factory-local-runs.md`; ADR 0051 (retiring a claim is a named, fail-closed operation that leaves a record) | |
| 7 | Guard the failure direction: retiring a `running` holder must REFUSE with a non-zero exit and change nothing | the test that stops this becoming a foot-gun |

## Validation

- **The acceptance is the end-to-end:** retire the parked run holding `#169`'s claim, then run the launcher again and
  see a NEW run start (not a refusal) — the loop that was open in R1 is closed.
- **Refuse-live:** a `running` holder cannot be retired; the command exits non-zero, names the holder, and the ledger
  is unchanged (asserted by reading it back).
- **The record survives:** after retirement the run is still readable, with its retirement reason, and the ticket is
  left with an honest label.
- **Nothing else regresses:** `tsc --noEmit`, the full suite, `eve build`, the doc/ADR/env-coverage guards, and the
  local lint gate over the WHOLE diff file set (`git diff --name-only <base>..HEAD`) — the plan file included, since
  CI lints it.

## Risks

1. **Retirement as a race.** Between reading the holder and writing the retirement, the holder could resume. The
   store must do the read and the transition together (a single guarded statement / transaction), not as two calls
   from the command.
2. **Retiring the wrong thing.** The command takes a repo and an issue; it must print the holder it is about to
   retire and refuse if the ledger holds no claim, rather than silently succeeding.
3. **Two truths about one run.** If the retirement status were stored somewhere other than the run's own record, the
   dashboard and the summary could disagree; keep it on the run.
4. **Scope creep into orchestration.** R2 does not change when a run parks or why; it only makes abandoning one
   possible and honest.

## Out of scope

- Automatic expiry of stale claims by age (a heuristic clock could retire a run a human was about to answer). The
  operator decides; R2 gives them the operation and a record.
- Any change to the control plane's pause/stop semantics, or to the deployed path.
