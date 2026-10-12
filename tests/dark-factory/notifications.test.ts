import { describe, expect, it } from "vitest";
import {
  ConsoleNotificationProvider,
  NOTIFICATION_KINDS,
  createNotificationProvider,
  isNotificationsConfigured,
  toNotification,
} from "../../agent/lib/dark-factory/notifications";

const base = {
  kind: "started" as const,
  runId: "run-1",
  repo: "Owner/Repo",
  issue: 317,
  status: "queued" as const,
  stage: "trigger" as const,
  occurredAt: "2026-10-11T12:00:00.000Z",
};

describe("notification payload (#317)", () => {
  it("accepts the closed kind vocabulary", () => {
    expect(NOTIFICATION_KINDS).toEqual([
      "started",
      "succeeded",
      "failed",
      "aborted",
      "parked",
      "tripped",
    ]);
    expect(toNotification(base).kind).toBe("started");
  });

  it("refuses a kind outside the vocabulary", () => {
    expect(() =>
      toNotification({ ...base, kind: "pinged" as never }),
    ).toThrow();
  });

  it("cannot carry free text: the payload is exactly the machine-readable fields", () => {
    const notification = toNotification({
      ...base,
      issueBody: "the secret issue text",
    } as never);

    expect(Object.keys(notification).sort()).toEqual([
      "issue",
      "kind",
      "occurredAt",
      "repo",
      "runId",
      "stage",
      "status",
    ]);
    expect(JSON.stringify(notification)).not.toContain("secret");
  });

  it("bounds the identifiers", () => {
    expect(() => toNotification({ ...base, runId: "" })).toThrow();
    expect(() => toNotification({ ...base, repo: "x".repeat(400) })).toThrow();
    expect(() => toNotification({ ...base, issue: 0 })).toThrow();
  });

  it("reports 'not configured' rather than claiming a delivery it did not make", async () => {
    const provider = new ConsoleNotificationProvider();

    const result = await provider.notify(toNotification(base));

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("dry-run");
    expect(result.error).toMatch(/not configured/i);
  });
});

describe("notification provider selection (#317)", () => {
  it("is OPT-IN: with nothing set the no-op default applies and nothing is configured", () => {
    expect(createNotificationProvider({}).id).toBe("console");
    expect(isNotificationsConfigured({})).toBe(false);
    expect(isNotificationsConfigured({ DF_NOTIFY_DRIVER: "console" })).toBe(
      false,
    );
  });

  it("throws on an unknown driver rather than losing notifications silently", () => {
    expect(() =>
      createNotificationProvider({ DF_NOTIFY_DRIVER: "slackk" }),
    ).toThrow(/supported/i);
  });
});
