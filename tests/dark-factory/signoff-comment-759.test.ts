import { describe, expect, it } from "vitest";

import { renderSignOffComment } from "../../agent/lib/dark-factory/dod-presentation";

const PR = { prNumber: 261, prUrl: "https://github.com/ricardoblackskye/WebFeedPOC/pull/261" };

/**
 * #759 task 4. The comment a delivered run posts.
 *
 * The third case is the control that answers the original report directly: the text must contain no
 * language about a plan being synthesized or a pipeline being dispatched, because that is what made a
 * finished issue read as though a new process had started.
 */
describe("the sign-off comment (#759)", () => {
  it("names the pull request and asks for one of the two words that decide it", () => {
    const body = renderSignOffComment({
      ...PR,
      checks: { passing: 3, failing: 0, pending: 1 },
    });

    expect(body).toContain("#261");
    expect(body).toContain(PR.prUrl);
    expect(body).toMatch(/Approved/);
    expect(body).toMatch(/Rejected/);
    expect(body).toMatch(/sign.?off/i);
  });

  it("names the check that failed, not merely that one did", () => {
    const body = renderSignOffComment({
      ...PR,
      checks: {
        passing: 2,
        failing: 1,
        pending: 0,
        failingNames: ["Playwright E2E"],
      },
    });

    expect(body).toContain("Playwright E2E");
    expect(body).toMatch(/failing/i);
  });

  // The control: no new-process language, ever.
  it("never reads as though a plan or a pipeline is starting", () => {
    const body = renderSignOffComment({ ...PR });

    expect(body).not.toMatch(/Synthesizing ExecutionPlan/i);
    expect(body).not.toMatch(/Dispatched Hardened Pipeline/i);
    expect(body).not.toMatch(/pre-flight/i);
    expect(body).not.toMatch(/needs-answer/);
  });

  it("still asks for sign-off when the checks are not yet reported", () => {
    const body = renderSignOffComment({ ...PR });

    expect(body).toContain("#261");
    expect(body).toMatch(/Approved/);
  });
});
