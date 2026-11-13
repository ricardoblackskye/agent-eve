/**
 * The Dark Factory handoff must ask the ROOT agent to DELEGATE to the Orchestrator
 * subagent — the same pattern the webhook already uses for the other roles
 * ("Please delegate to the Product Owner subagent", app/api/github/webhook/route.ts:664;
 * "the Sprint Metrics Analyst subagent", :515).
 *
 * Without it the handoff reaches the ROOT chat agent — the default Eve assistant — which is
 * NOT the Orchestrator. That collision is what #629 exists to remove: the root chat must stay
 * default Eve, and the Orchestrator must be a separate agent it delegates to.
 */
import { describe, expect, it } from "vitest";
import {
  renderHandoffMessage,
  type DispatchIntent,
} from "../agent/lib/dark-factory/entry";

const intent: DispatchIntent = {
  kind: "trigger",
  runId: "run-629-handoff",
  repo: "owner/repo",
  issue: 629,
  resume: false,
  issueTitle: "Add a footer",
  issueBody: "Body text",
};

describe("dark-factory handoff delegation", () => {
  it("asks the root agent to delegate to the Orchestrator subagent", () => {
    const message = renderHandoffMessage(intent);
    expect(message).toMatch(/delegate to the Orchestrator subagent/i);
  });

  it("still labels the issue text as data, never as instructions", () => {
    const message = renderHandoffMessage(intent);
    expect(message).toMatch(/user-supplied data/);
    expect(message).toMatch(/not instructions/);
  });
});
