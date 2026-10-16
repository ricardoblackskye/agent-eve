/**
 * #373 — a run refused by an ACTIVE claim must not start.
 *
 * This is the cleaner replacement for the fallback that produced the orphan. The sequence that blocked the
 * UAT was:
 *
 *   1. an earlier attempt left a row active (never finalised);
 *   2. the next attempt was REFUSED the delivery because that claim was held;
 *   3. it carried on anyway with the ATTEMPT id as a synthetic run id;
 *   4. so its lifecycle writes targeted a run the ledger had never heard of, the old row kept the claim, and
 *      the issue became permanently un-runnable.
 *
 * Two runs must never work one issue — that is the whole point of the claim — so step 3 is the mistake. What
 * replaces it is a distinction the previous code could not make:
 *
 *   - an UNCONFIGURED ledger (no driver at all) is a local convenience and still falls back, loudly, exactly
 *     as documented: a developer running the factory locally must not need a database;
 *   - an ACTIVE CONFLICT is the ledger telling us another run owns this issue. Proceeding is not a degraded
 *     mode, it is a second run on the same issue. The run stops and names the holder.
 *
 * `refuseToStartReason` is pure and returns null for the cases that must still run, so the guard cannot
 * accidentally block local use.
 */
import { describe, it, expect } from "vitest";
import { beginRunRecord, refuseToStartReason } from "../../agent/lib/dark-factory/run-record";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

function storeReturning(result: unknown): RunHistoryStore {
  return { acceptDelivery: async () => result } as unknown as RunHistoryStore;
}

const REPO = "ricardoblackskye/webfeedpoc";

const ACTIVE_CONFLICT = {
  ok: true,
  mode: "live",
  providerId: "sqlite",
  duplicate: false,
  activeConflict: { runId: "run-hold-1", status: "queued" },
};

const UNCONFIGURED = {
  ok: false,
  mode: "blocked",
  providerId: "console",
  error: "run history is not configured",
};

describe("#373 a run refused by an active claim does not start", () => {
  it("names the run holding the claim, and says the run will not start", async () => {
    const begun = await beginRunRecord({
      history: storeReturning(ACTIVE_CONFLICT),
      attemptId: "attempt-11",
      repo: REPO,
      issue: 161,
      log: () => {},
    });

    const reason = refuseToStartReason(begun);

    expect(reason).not.toBeNull();
    expect(reason).toContain("run-hold-1");
    expect(reason).toContain("queued");
    expect(reason).toContain(`${REPO}#161`);
  });

  it("carries the conflict on the result, so the guard is not matching on a message", async () => {
    const begun = await beginRunRecord({
      history: storeReturning(ACTIVE_CONFLICT),
      attemptId: "attempt-11",
      repo: REPO,
      issue: 161,
      log: () => {},
    });

    expect(begun.activeConflict).toEqual({ runId: "run-hold-1", status: "queued" });
  });

  it("lets a RECORDED run start", async () => {
    const begun = await beginRunRecord({
      history: storeReturning({
        ok: true,
        mode: "live",
        providerId: "sqlite",
        duplicate: false,
        value: { runId: "run-ok-1", repo: REPO, issue: 161, status: "queued" },
      }),
      attemptId: "attempt-12",
      repo: REPO,
      issue: 161,
      log: () => {},
    });

    expect(begun.recorded).toBe(true);
    expect(refuseToStartReason(begun)).toBeNull();
  });

  it("still lets an UNCONFIGURED ledger fall back, so local runs keep working", async () => {
    const begun = await beginRunRecord({
      history: storeReturning(UNCONFIGURED),
      attemptId: "attempt-13",
      repo: REPO,
      issue: 161,
      log: () => {},
    });

    // The documented local convenience: no driver, no database, run anyway and say so loudly.
    expect(begun.recorded).toBe(false);
    expect(begun.fellBack).toBe(true);
    expect(refuseToStartReason(begun)).toBeNull();
  });
});
