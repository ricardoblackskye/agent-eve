/**
 * #756 - the fix pass that produced nothing, and said nothing about it.
 *
 * Observed live on WebFeedPOC#262 and #264: three passes, each logging
 *
 *     Fix cycle   authored 0 file(s) for 1 finding(s)
 *
 * while the ticket showed only a bare `df:blocked`. The module s own documentation names why that
 * matters - "a pass that tried fifty findings and reported nothing would be indistinguishable from one
 * that tried none" - and the same is true of a single finding. The empty pass is INDISTINGUISHABLE from
 * no attempt, so the operator cannot tell whether a fix was tried.
 *
 * The code path, read: `runPass` only produces dispositions from `changedFiles.length > 0`, then from
 * explained refusals. An empty pass with no refusals therefore returns `[]` - nothing resolved, nothing
 * explained, nothing retried.
 *
 * So two things are RED here: an empty pass is not retried, and it is not reported.
 */
import { describe, expect, it, vi } from "vitest";

import { createFixCycle } from "../../agent/lib/dark-factory/fix-cycle";
import type { ReviewFinding } from "../../agent/lib/dark-factory/definition-of-done";

const FINDING: ReviewFinding = {
  id: "f-empty-1",
  source: "test", // a failed e2e check (#718 keeps the PATH, which is what a finding must have to be acted on)
  message: "the e2e check failed",
  severity: "error",
};

function harness(authorResults: unknown[]) {
  const logs: string[] = [];
  let call = 0;
  const author = vi.fn(async () => authorResults[Math.min(call++, authorResults.length - 1)]);
  const push = vi.fn(async () => ({ ok: true }));
  const ports = {
    log: (_bucket: string, message: string) => logs.push(message),
    openWorkspace: async () => ({ ok: true, workspace: { branch: "feat/dark-factory-264" } }),
    closeWorkspace: async () => {},
    author,
    push,
  } as never;
  return { ports, author, push, logs };
}

describe("an empty fix pass is retried and reported (#756)", () => {
  it("retries once when the authoring pass produces nothing", async () => {
    const h = harness([
      { changedFiles: [], refusals: [] },
      { changedFiles: ["src/pages/HomePage.jsx"], refusals: [] },
    ]);

    const dispositions = await createFixCycle(h.ports)([FINDING]);

    // The wire: an empty pass is an ATTEMPT THAT PRODUCED NOTHING, not a finished pass.
    expect(h.author).toHaveBeenCalledTimes(2);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(dispositions).toContainEqual({ findingId: FINDING.id, status: "resolved" });
  });

  it("stops after the retry and says on the record that nothing was produced", async () => {
    const h = harness([
      { changedFiles: [], refusals: [] },
      { changedFiles: [], refusals: [] },
    ]);

    const dispositions = await createFixCycle(h.ports)([FINDING]);

    // Bounded, like every other ceiling in this module: a retry, not a loop.
    expect(h.author).toHaveBeenCalledTimes(2);
    // And legible: the operator must be able to tell an attempt-that-produced-nothing from no attempt.
    expect(h.logs.join("\n")).toMatch(/no change|produced nothing|authored nothing/i);
    expect(dispositions).toEqual([]);
  });

  // The control: a pass that DOES produce work is not retried, and must not be.
  it("does not retry when the first pass authored a file", async () => {
    const h = harness([{ changedFiles: ["src/a.ts"], refusals: [] }]);

    const dispositions = await createFixCycle(h.ports)([FINDING]);

    expect(h.author).toHaveBeenCalledTimes(1);
    expect(dispositions).toContainEqual({ findingId: FINDING.id, status: "resolved" });
  });
});
