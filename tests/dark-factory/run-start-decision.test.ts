/**
 * #373 — starting, adopting, or refusing.
 *
 * The resume problem this pins. #365 R4 parks a run between planning and coding, and recording that question
 * is what marks the run `blocked` — which is a CLAIM-HOLDING status. So the run waiting for approval is also
 * the run holding the claim.
 *
 * The resume then arrives as an ordinary dispatch. `resolveRunnerRunId` mints `run-<issue>-<now>`, so the
 * resume's delivery identity is NEW, `acceptDelivery` sees a live claim and refuses, and a guard that only
 * knows how to refuse would make the approval gate a dead end: approve the plan, and the run can never
 * continue.
 *
 * So the decision has three outcomes, not two:
 *
 *   - START   the ledger recorded this attempt (or there is no ledger at all, the documented local fallback);
 *   - ADOPT   a RESUME against a BLOCKED holder. The blocked run IS the run being approved, because a resume
 *             is explicit and cannot be produced by a re-delivery (#365 R4), so continuing it is the whole
 *             point. The adopted run id matters: it is what makes the resumed run's lifecycle writes land on
 *             the real run instead of a phantom — the orphan this issue is about;
 *   - REFUSE  anything else, including a resume against a run that is genuinely in flight. A `running` holder
 *             must never be adopted: that is another attempt's live work.
 */
import { describe, it, expect } from "vitest";
import {
  beginRunRecord,
  decideRunStart,
  refuseToStartReason,
} from "../../agent/lib/dark-factory/run-record";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const REPO = "ricardoblackskye/webfeedpoc";

function storeReturning(result: unknown): RunHistoryStore {
  return { acceptDelivery: async () => result } as unknown as RunHistoryStore;
}

async function begin(result: unknown) {
  return beginRunRecord({
    history: storeReturning(result),
    attemptId: "attempt-20",
    repo: REPO,
    issue: 162,
    log: () => {},
  });
}

function conflict(status: string) {
  return {
    ok: true,
    mode: "live",
    providerId: "sqlite",
    duplicate: false,
    activeConflict: { runId: "run-hold-1", status },
  };
}

const UNCONFIGURED = {
  ok: false,
  mode: "blocked",
  providerId: "console",
  error: "run history is not configured",
};

describe("#373 starting, adopting, or refusing", () => {
  it("starts a run the ledger recorded", async () => {
    const decision = decideRunStart(
      await begin({
        ok: true,
        mode: "live",
        providerId: "sqlite",
        duplicate: false,
        value: { runId: "run-ok-1" },
      }),
    );

    expect(decision).toEqual({ kind: "start", runId: "run-ok-1" });
  });

  it("still starts on the unconfigured local fallback", async () => {
    const begun = await begin(UNCONFIGURED);

    expect(decideRunStart(begun).kind).toBe("start");
    // Non-vacuous: the fallback really did fall back, so this is the local case and not a recorded run.
    expect(begun.fellBack).toBe(true);
  });

  it("refuses a FRESH run while a claim is held", async () => {
    const decision = decideRunStart(await begin(conflict("blocked")));

    expect(decision.kind).toBe("refuse");
  });

  it("ADOPTS the blocked run on a resume — that run is the one being approved", async () => {
    const decision = decideRunStart(await begin(conflict("blocked")), {
      resuming: true,
    });

    expect(decision).toEqual({ kind: "adopt", runId: "run-hold-1" });
  });

  it("refuses a resume against a run that is genuinely in flight", async () => {
    for (const status of ["running", "queued"]) {
      const decision = decideRunStart(await begin(conflict(status)), {
        resuming: true,
      });

      expect(decision.kind, `${status} must not be adopted`).toBe("refuse");
    }
  });

  it("agrees with refuseToStartReason, so the two cannot drift", async () => {
    const blocked = await begin(conflict("blocked"));
    const live = await begin(conflict("running"));

    expect(refuseToStartReason(blocked)).not.toBeNull();
    expect(refuseToStartReason(blocked, { resuming: true })).toBeNull();
    expect(refuseToStartReason(live, { resuming: true })).not.toBeNull();
  });
});
