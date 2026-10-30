/**
 * #559 — the coding loop reports an iteration that could not be measured.
 *
 * `WorkerResult.unmeasured` is documented as distinguishing an iteration whose tests could
 * not even start (an unprovisioned checkout, #541) from a failure of the developer's work.
 * The loop currently reads only `.passed`, so that distinction is discarded and the run
 * reports the unprovisioned case as the developer's failure.
 *
 * The loop stays pure: it classifies and hands the iteration to an optional tap, and the
 * boundary that already owns a reporter does the posting.
 */
import { describe, expect, it, vi } from "vitest";
import {
  runCodingLoop,
  type WorkerResult,
} from "../../agent/lib/dark-factory/developer-agent";
import { resolveAgentOutputRecorder } from "../../agent/lib/dark-factory/agent-output";

describe("the coding loop surfaces an unmeasured iteration (#559)", () => {
  it("hands the unmeasured iteration to the caller's tap, once", async () => {
    const onUnmeasured = vi.fn();
    // ONE unmeasured iteration, then measured failures. The first fixture returned unmeasured on
    // EVERY attempt, which cannot tell "one tap call per run" from "one per iteration" - the tap
    // fires per unmeasured iteration by design, so the fixture has to isolate a single one.
    let calls = 0;
    const result = await runCodingLoop({
      maxIterations: 2,
      onUnmeasured,
      worker: async (): Promise<WorkerResult> => {
        calls += 1;
        return calls === 1
          ? {
              passed: false,
              unmeasured: true,
              output: "the checkout is not provisioned",
            }
          : { passed: false, output: "a real failure on the second attempt" };
      },
    });

    expect(onUnmeasured).toHaveBeenCalledTimes(1);
    const info = onUnmeasured.mock.calls[0][0];
    expect(info.iteration).toBe(1);
    expect(info.output).toBe("the checkout is not provisioned");
    // The tap is an ADDITION: the outcome the caller already relies on is unchanged.
    expect(result.status).toBe("failed");
  });

  it("does not tap a measured failure", async () => {
    // Control: the roadblock is for the unmeasured case, not for every failed attempt.
    const onUnmeasured = vi.fn();
    await runCodingLoop({
      maxIterations: 2,
      onUnmeasured,
      worker: async (): Promise<WorkerResult> => ({
        passed: false,
        output: "the test failed for a real reason",
      }),
    });

    expect(onUnmeasured).not.toHaveBeenCalled();
  });

  it("does not tap a passing iteration", async () => {
    // Control: a clean run captures NOTHING, so the capture cannot creep into every result.
    const onUnmeasured = vi.fn();
    const result = await runCodingLoop({
      maxIterations: 2,
      onUnmeasured,
      worker: async (): Promise<WorkerResult> => ({ passed: true }),
    });

    expect(onUnmeasured).not.toHaveBeenCalled();
    expect(result.status).toBe("success");
  });

  it("works when no tap is supplied at all", async () => {
    // The option is optional: existing callers must keep compiling and behaving.
    const result = await runCodingLoop({
      maxIterations: 1,
      worker: async (): Promise<WorkerResult> => ({ passed: true }),
    });

    expect(result).toEqual({ status: "success", iterations: 1, fixCycles: 0 });
  });
});

describe("an unmeasured iteration maps to a recoverable roadblock (#559)", () => {
  it("prepares a bounded, redacted roadblock and never forces a blocked status", () => {
    const recorder = resolveAgentOutputRecorder("developer");
    const prepared = recorder.prepare({
      profile: "developer",
      type: "roadblock",
      text: "the checkout is not provisioned:\nDF_API_KEY=placeholder-not-a-real-key\nretrying",
    });

    expect(prepared.type).toBe("worker.roadblock");
    // A roadblock is recoverable. worker.question requires "blocked" and that is what parks a
    // run on a human, so borrowing it here would stall the factory.
    expect(prepared.status).toBeUndefined();
    expect(prepared.text).toContain("[redacted DF_API_KEY]");
    expect(prepared.text).not.toContain("placeholder-not-a-real-key");
  });
});
