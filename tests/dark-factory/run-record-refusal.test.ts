import { describe, expect, it } from "vitest";
import { beginRunRecord, decideRunStart } from "../../agent/lib/dark-factory/run-record";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

/**
 * A refused run record must say WHY (#373).
 *
 * A real local run against another repo printed "the ledger refused the delivery" and then advised setting
 * `DF_RUN_HISTORY_DRIVER` — which was already set, and which the store had already read correctly.
 *
 * The actual cause was the ADR 0026 atomic active-run claim: an earlier attempt still held
 * `ricardoblackskye/WebFeedPOC#161`, so this one could not be recorded. The sqlite store signals that as
 * `{ ok: true, activeConflict }` with NO `value`, and `beginRunRecord` treats a missing `value` as a
 * refusal — so the one fact an operator needed (WHICH run holds the claim, and in what state) was the one
 * fact thrown away.
 */
function storeReturning(result: unknown): RunHistoryStore {
  return { acceptDelivery: async () => result } as unknown as RunHistoryStore;
}

const ACTIVE = {
  ok: true,
  mode: "live",
  providerId: "sqlite",
  duplicate: false,
  activeConflict: { runId: "run-active-1", status: "queued" },
};

describe("a refused run record says why (#373)", () => {
  it("names the active run holding the claim, rather than a generic refusal", async () => {
    const lines: string[] = [];
    const result = await beginRunRecord({
      history: storeReturning(ACTIVE),
      attemptId: "attempt-9",
      repo: "ricardoblackskye/WebFeedPOC",
      issue: 161,
      log: (message) => lines.push(message),
    });

    expect(result.recorded).toBe(false);
    expect(result.error).toContain("run-active-1");
    expect(result.error).toContain("queued");
    expect(result.error).toContain("ricardoblackskye/WebFeedPOC#161");
  });

  it("does not blame the driver when the driver is configured", async () => {
    const lines: string[] = [];
    await beginRunRecord({
      history: storeReturning(ACTIVE),
      attemptId: "attempt-9",
      repo: "ricardoblackskye/WebFeedPOC",
      issue: 161,
      log: (message) => lines.push(message),
    });

    expect(lines.join("\n")).not.toMatch(/Set DF_RUN_HISTORY_DRIVER/);
  });

  it("still points at the driver when the store is the unconfigured one", async () => {
    const lines: string[] = [];
    const result = await beginRunRecord({
      history: storeReturning({
        ok: false,
        mode: "blocked",
        providerId: "console",
        error: "run history is not configured",
      }),
      attemptId: "attempt-10",
      repo: "ricardoblackskye/WebFeedPOC",
      issue: 161,
      log: (message) => lines.push(message),
    });

    expect(result.recorded).toBe(false);
    expect(lines.join("\n")).toMatch(/DF_RUN_HISTORY_DRIVER/);
  });
});

/**
 * #675 - a resume that adopts its own run must not be announced as a failure.
 *
 * Both real resumes printed
 *
 *   [WARN] The run record could not be opened: the ledger already holds an active run
 *   (58c2f9e6-..., status 'blocked') for ricardoblackskye/webfeedpoc#230, so this attempt
 *   was not recorded.
 *
 * and 58c2f9e6 IS the run that resume then continued (identical for #228 and dc611b92). The conflict
 * is real; the verdict was wrong. `decideRunStart` already answers this case - `{ kind: "adopt" }` for
 * a resume meeting a `blocked` holder - but `beginRunRecord` logged before the caller decided, so the
 * log contradicted the next line of code.
 */
describe("#675 a resume that adopts its run is not a failure", () => {
  const BLOCKED = {
    ok: true,
    mode: "live",
    providerId: "sqlite",
    duplicate: false,
    activeConflict: { runId: "run-blocked-1", status: "blocked" },
  };

  const open = async (
    claim: unknown,
    options: { resuming?: boolean } = {},
  ): Promise<{ lines: string[]; result: Awaited<ReturnType<typeof beginRunRecord>> }> => {
    const lines: string[] = [];
    const result = await beginRunRecord({
      history: storeReturning(claim),
      attemptId: "attempt-20",
      repo: "ricardoblackskye/WebFeedPOC",
      issue: 230,
      log: (message) => lines.push(message),
      ...options,
    });
    return { lines, result };
  };

  it("reports the adoption of a blocked run rather than warning that nothing was recorded", async () => {
    const { lines, result } = await open(BLOCKED, { resuming: true });
    const logged = lines.join("\n");

    expect(result.activeConflict).toEqual({ runId: "run-blocked-1", status: "blocked" });
    expect(logged).not.toContain("[WARN]");
    expect(logged).not.toContain("this attempt was not recorded");
    expect(logged).toContain("run-blocked-1");
    expect(logged).toContain("resuming");
  });

  it("CONTROL - the same conflict WITHOUT a resume is still a warning", async () => {
    // Without this control the fix could pass by silencing a conflict that really is one.
    const { lines } = await open(BLOCKED, { resuming: false });
    const logged = lines.join("\n");

    expect(logged).toContain("[WARN]");
    expect(logged).toContain("this attempt was not recorded");
    expect(logged).toContain("run-blocked-1");
    expect(logged).toContain("blocked");
  });

  it("still refuses when a resume meets a run that is not parked awaiting approval", async () => {
    // ACTIVE's holder is 'queued': a resume cannot adopt it, so the warning must stand.
    const { lines, result } = await open(ACTIVE, { resuming: true });
    const logged = lines.join("\n");

    expect(logged).toContain("[WARN]");
    expect(logged).toContain("this attempt was not recorded");
    expect(decideRunStart(result, { resuming: true }).kind).toBe("refuse");
  });

  it("AGREES with decideRunStart, so the log and the decision cannot drift apart", async () => {
    // The log is derived from the decision rather than re-testing the status, and this pins that.
    for (const [claim, resuming, kind] of [
      [BLOCKED, true, "adopt"],
      [BLOCKED, false, "refuse"],
      [ACTIVE, true, "refuse"],
    ] as const) {
      const { lines, result } = await open(claim, { resuming });
      const decision = decideRunStart(result, { resuming });
      expect(decision.kind).toBe(kind);
      const warned = lines.join("\n").includes("[WARN]");
      expect(warned).toBe(kind === "refuse");
    }
  });
});
