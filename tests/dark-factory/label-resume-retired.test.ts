import { describe, it, expect } from "vitest";
import {
  decideDarkFactoryTrigger,
  TRIGGER_LABELS,
} from "../../agent/lib/dark-factory/trigger";

// #309: the comment reply is the ONLY resume path. Clearing the `needs-answer`
// label must stop resuming a parked run (it becomes a `not-a-trigger` that names
// the retirement). Before the fix, decideDarkFactoryTrigger() returned `resume`
// for a cleared question label.

const ENV = {
  DF_TRIGGER_LABEL: "dark-factory",
  DF_WORKER_ALLOWED_REPOS: "ricardoblackskye/agent-eve",
  DF_TRIGGER_ALLOWED_USERS: "ricardoblackskye",
};

function payload(over: Record<string, unknown> = {}) {
  return {
    action: "labeled",
    label: { name: "dark-factory" },
    sender: { login: "ricardoblackskye" },
    repository: { full_name: "ricardoblackskye/agent-eve" },
    issue: {
      number: 163,
      title: "Do the thing",
      body: "Intent: do it.",
      labels: [],
    },
    ...over,
  } as never;
}

describe("#309: clearing the needs-answer label no longer resumes a parked run", () => {
  it("returns not-a-trigger (not resume) and names the retirement", () => {
    const decision = decideDarkFactoryTrigger(
      payload({
        action: "unlabeled",
        label: { name: TRIGGER_LABELS.question },
      }),
      ENV,
    );
    expect(decision.kind).toBe("not-a-trigger");
    expect(decision.reason).toMatch(/retired/i);
  });

  it("still resumes via a comment reply (the only remaining path)", () => {
    const decision = decideDarkFactoryTrigger(
      payload({
        action: "created",
        comment: { body: "go ahead" },
      }),
      ENV,
    );
    expect(decision.kind).toBe("resume");
  });
});
