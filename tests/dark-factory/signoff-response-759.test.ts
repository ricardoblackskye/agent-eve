import { describe, expect, it } from "vitest";

import { classifySignOffResponse } from "../../agent/lib/dark-factory/signoff-response";

/**
 * #759 task 5. The two words that decide a delivered run.
 *
 * The third block is the one that matters: a reply carrying BOTH a sign-off and a request must not sign
 * anything off, because the request is what has to be honoured next. Acting on it would close a pull
 * request on the strength of a sentence that was asking for a change.
 */
describe("the sign-off reply (#759)", () => {
  it("reads an approval however it is formatted", () => {
    expect(classifySignOffResponse("Approved").kind).toBe("approved");
    expect(classifySignOffResponse(" **approve** ").kind).toBe("approved");
    expect(classifySignOffResponse("Approved.").kind).toBe("approved");
  });

  it("reads a rejection, and says what it will do", () => {
    const decision = classifySignOffResponse("Rejected");
    expect(decision.kind).toBe("rejected");
    expect(decision.reason).toMatch(/reject/i);
  });

  // Fail-closed: no decision is reached on a reply that is not exactly one of the two words.
  it("reaches no decision when the reply carries a request as well", () => {
    expect(classifySignOffResponse("Approved, but also update the header").kind).toBe("none");
    expect(classifySignOffResponse("looks good, but change the footer").kind).toBe("none");
    expect(classifySignOffResponse("").kind).toBe("none");
  });

  it("does not treat a plan idiom as a sign-off", () => {
    expect(classifySignOffResponse("ship it").kind).toBe("none");
    expect(classifySignOffResponse("lgtm").kind).toBe("none");
  });

  it("explains every decision it reaches", () => {
    expect(classifySignOffResponse("Approved").reason.length).toBeGreaterThan(0);
    expect(classifySignOffResponse("Rejected").reason.length).toBeGreaterThan(0);
    expect(classifySignOffResponse("what about the tests?").reason.length).toBeGreaterThan(0);
  });
});
