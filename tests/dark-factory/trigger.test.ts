/**
 * #163 — the Dark Factory kick-off trigger (cycles 1-8).
 *
 * Mirrors `agent/lib/story-trigger.ts` deliberately: a payload type, env-overridable
 * defaults, and a PURE decision that is unit-testable offline. One trigger style in
 * the repo, not two.
 *
 * The decision returns WHY, not just a boolean, because the three outcomes are
 * genuinely different to a webhook caller: `not-a-trigger` is a 200 fall-through
 * ("nothing for us"), while `refused` is a real gate doing its job and must be
 * visible — the fail-closed lesson from #78, where an absent configuration was read
 * as permission to relax the control.
 */
import { describe, it, expect } from "vitest";
import {
  decideDarkFactoryTrigger,
  TRIGGER_DEFAULTS,
  TRIGGER_LABELS,
} from "../../agent/lib/dark-factory/trigger";

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

describe("#163 cycle 1-2: one label requests work", () => {
  it("triggers on the configured label from an allow-listed actor in an allow-listed repo", () => {
    const d = decideDarkFactoryTrigger(payload(), ENV);
    expect(d.kind).toBe("trigger");
    expect(d.repo).toBe("ricardoblackskye/agent-eve");
    expect(d.issue).toBe(163);
    expect(d.actor).toBe("ricardoblackskye");
  });

  it("matches the label CASE-INSENSITIVELY and ignores other labels", () => {
    expect(
      decideDarkFactoryTrigger(
        payload({ label: { name: "Dark-Factory" } }),
        ENV,
      ).kind,
    ).toBe("trigger");
    expect(
      decideDarkFactoryTrigger(payload({ label: { name: "bug" } }), ENV).kind,
    ).toBe("not-a-trigger");
  });

  it("honours DF_TRIGGER_LABEL, so the vocabulary is the operator's", () => {
    const d = decideDarkFactoryTrigger(payload({ label: { name: "df-go" } }), {
      ...ENV,
      DF_TRIGGER_LABEL: "df-go",
    });
    expect(d.kind).toBe("trigger");
    expect(TRIGGER_DEFAULTS.label).toBe("dark-factory");
  });
});

describe("#163 cycle 3-4: never fire on something that cannot be a fresh run", () => {
  it("never fires for a pull_request payload", () => {
    expect(
      decideDarkFactoryTrigger(payload({ pull_request: {} }), ENV).kind,
    ).toBe("not-a-trigger");
  });

  it("never fires for closed/deleted actions", () => {
    for (const action of ["closed", "deleted"]) {
      expect(decideDarkFactoryTrigger(payload({ action }), ENV).kind).toBe(
        "not-a-trigger",
      );
    }
  });

  it("never re-triggers a run that already reached a terminal label", () => {
    for (const terminal of [TRIGGER_LABELS.done, TRIGGER_LABELS.failed]) {
      const d = decideDarkFactoryTrigger(
        payload({ issue: { number: 163, labels: [{ name: terminal }] } }),
        ENV,
      );
      expect(d.kind).toBe("not-a-trigger");
    }
  });
});

describe("#163 cycle 5-8: authorisation is fail-closed, and the reason is returned", () => {
  it("REFUSES a repo outside the allow-list, naming it", () => {
    const d = decideDarkFactoryTrigger(
      payload({ repository: { full_name: "someone/other" } }),
      ENV,
    );
    expect(d.kind).toBe("refused");
    expect(d.reason).toMatch(/someone\/other/);
  });

  it("REFUSES a sender outside the actor allow-list", () => {
    const d = decideDarkFactoryTrigger(
      payload({ sender: { login: "passer-by" } }),
      ENV,
    );
    expect(d.kind).toBe("refused");
    expect(d.reason).toMatch(/passer-by/);
  });

  it("REFUSES when either allow-list is unset or empty — never allow-everything", () => {
    for (const env of [
      { ...ENV, DF_WORKER_ALLOWED_REPOS: undefined },
      { ...ENV, DF_WORKER_ALLOWED_REPOS: "" },
      { ...ENV, DF_TRIGGER_ALLOWED_USERS: undefined },
      { ...ENV, DF_TRIGGER_ALLOWED_USERS: "   " },
    ]) {
      const d = decideDarkFactoryTrigger(payload(), env);
      expect(d.kind).toBe("refused");
    }
  });

  it("distinguishes not-a-trigger from refused, so a caller can answer honestly", () => {
    const unrelated = decideDarkFactoryTrigger(
      payload({ label: { name: "bug" } }),
      {
        ...ENV,
        DF_WORKER_ALLOWED_REPOS: "", // gates closed
      },
    );
    expect(unrelated.kind).toBe("not-a-trigger"); // not our label: never gated, just not ours
    expect(unrelated.reason).toMatch(/not a dark-factory/i);
  });

  it("never triggers when the actor is allowed but the label is absent", () => {
    const noLabel = decideDarkFactoryTrigger(
      payload({ label: undefined }),
      ENV,
    );
    expect(noLabel.kind).toBe("not-a-trigger");
  });

  it("truncates and never echoes an unbounded reason", () => {
    const d = decideDarkFactoryTrigger(
      payload({ repository: { full_name: `x/${"y".repeat(5000)}` } }),
      ENV,
    );
    expect(d.kind).toBe("refused");
    expect(d.reason.length).toBeLessThan(500);
  });
});

describe("#163 cycle 12: the two label removals mean different things", () => {
  it("removing the trigger label ABORTS the run", () => {
    const d = decideDarkFactoryTrigger(
      payload({ action: "unlabeled", label: { name: "dark-factory" } }),
      ENV,
    );
    expect(d.kind).toBe("abort");
  });

  it("clearing the QUESTION label RESUMES the parked run", () => {
    const d = decideDarkFactoryTrigger(
      payload({
        action: "unlabeled",
        label: { name: TRIGGER_LABELS.question },
      }),
      ENV,
    );
    expect(d.kind).toBe("resume");
  });

  it("an unlabeled event for some other label changes nothing", () => {
    const d = decideDarkFactoryTrigger(
      payload({ action: "unlabeled", label: { name: "bug" } }),
      ENV,
    );
    expect(d.kind).toBe("not-a-trigger");
  });

  it("still enforces both gates on abort and resume", () => {
    const offRepo = payload({
      action: "unlabeled",
      label: { name: "dark-factory" },
      repository: { full_name: "someone/other" },
    });
    expect(decideDarkFactoryTrigger(offRepo, ENV).kind).toBe("refused");
  });
});
