import { describe, expect, it } from "vitest";
import { beginRunRecord } from "../../agent/lib/dark-factory/run-record";
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
