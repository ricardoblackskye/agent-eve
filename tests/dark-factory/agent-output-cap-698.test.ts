import { describe, expect, it } from "vitest";
import { resolveAgentOutputRecorder } from "../../agent/lib/dark-factory/agent-output";
import { MAX_QUESTION_CHARS } from "../../agent/lib/dark-factory/worker-reporter";

/**
 * #698 - the captured agent output IS the run's trace, so it has to hold a substantive turn.
 *
 * The capture bound and the reporter's hard limit are ONE authority over the same input: the captured
 * text is handed to the reporter, which refuses anything longer. Raising one without the other would
 * hand the reporter something it rejects - so the bound is raised for both, and still exists.
 */
describe("#698 the agent-trace capture holds a substantive turn", () => {
  it("keeps a several-thousand-character capture instead of truncating it", () => {
    const prepared = resolveAgentOutputRecorder("developer").prepare({
      profile: "developer",
      type: "milestone",
      text: "The developer changed the checkout flow. ".repeat(160),
    });

    expect(prepared.truncated).toBe(false);
    expect(prepared.text.length).toBeGreaterThan(MAX_QUESTION_CHARS > 2000 ? 2000 : 99999);
  });

  it("CONTROL: still bounds the capture, and says when it did", () => {
    const prepared = resolveAgentOutputRecorder("developer").prepare({
      profile: "developer",
      type: "milestone",
      text: "x".repeat(MAX_QUESTION_CHARS * 3),
    });

    expect(prepared.truncated).toBe(true);
    expect(prepared.text.length).toBe(MAX_QUESTION_CHARS);
  });
});
