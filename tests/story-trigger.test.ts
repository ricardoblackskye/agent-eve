import { describe, it, expect } from "vitest";
import { isStoryTrigger, TRIGGER_DEFAULTS } from "../agent/lib/story-trigger";

const basePayload = {
  action: "opened",
  issue: {
    number: 7,
    title: "Export CSV",
    body: "We need CSV export",
    labels: [],
  },
};

describe("isStoryTrigger", () => {
  it("fires on issues.opened when the body mentions the agent", () => {
    expect(
      isStoryTrigger({
        ...basePayload,
        issue: { ...basePayload.issue, body: "@eve-agent please draft this" },
      }),
    ).toBe(true);
  });

  it("does not fire on issues.opened without a mention", () => {
    expect(isStoryTrigger(basePayload)).toBe(false);
  });

  it("fires on issues.labeled with the trigger label", () => {
    expect(
      isStoryTrigger({
        action: "labeled",
        issue: {
          ...basePayload.issue,
          labels: [{ name: "needs-story" }],
        },
        label: { name: "needs-story" },
      }),
    ).toBe(true);
  });

  it("does not fire on issues.labeled with an unrelated label", () => {
    expect(
      isStoryTrigger({
        action: "labeled",
        issue: { ...basePayload.issue, labels: [{ name: "bug" }] },
        label: { name: "bug" },
      }),
    ).toBe(false);
  });

  it("is case-insensitive on the label", () => {
    expect(
      isStoryTrigger({
        action: "labeled",
        issue: { ...basePayload.issue, labels: [{ name: "Needs-Story" }] },
        label: { name: "Needs-Story" },
      }),
    ).toBe(true);
  });

  it("does not fire on issues.closed", () => {
    expect(
      isStoryTrigger({
        ...basePayload,
        action: "closed",
        issue: { ...basePayload.issue, body: "@eve-agent" },
      }),
    ).toBe(false);
  });

  it("does not fire on a pull_request payload", () => {
    expect(
      isStoryTrigger({ action: "opened", pull_request: { number: 1 } }),
    ).toBe(false);
  });

  it("respects env overrides for the mention", () => {
    process.env.EVE_STORY_MENTION = "@eve-bot";
    expect(
      isStoryTrigger({
        ...basePayload,
        issue: { ...basePayload.issue, body: "@eve-bot draft this" },
      }),
    ).toBe(true);
    delete process.env.EVE_STORY_MENTION;
  });

  it("exposes defaults", () => {
    expect(TRIGGER_DEFAULTS.mention).toBe("@eve-agent");
    expect(TRIGGER_DEFAULTS.label).toBe("needs-story");
  });
});
