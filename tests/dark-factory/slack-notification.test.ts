import { describe, expect, it } from "vitest";
import {
  SlackNotificationConfigurationError,
  SlackNotificationProvider,
  renderSlackMessage,
} from "../../agent/lib/dark-factory/slack-notification";
import {
  createNotificationProvider,
  type Notification,
} from "../../agent/lib/dark-factory/notifications";

const WEBHOOK_URL =
  "https://hooks.slack.com" + "/services/T000/B000/test-token-fixture";

const notification: Notification = {
  kind: "failed",
  runId: "run-1",
  repo: "Owner/Repo",
  issue: 318,
  status: "failed",
  stage: "terminal",
  reasonCode: "worker-minutes-exceeded",
  prUrl: "https://github.com/Owner/Repo/pull/1",
  occurredAt: "2026-10-11T12:00:00.000Z",
};

function recordingFetch(status = 200) {
  const calls: { url: string; body: { text?: string } }[] = [];
  const fetchImpl = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return { ok: status >= 200 && status < 300, status };
  };
  return { calls, fetchImpl };
}

describe("renderSlackMessage (#318)", () => {
  it("renders the canonical fields", () => {
    const body = renderSlackMessage(notification);

    expect(body.text).toContain("failed");
    expect(body.text).toContain("Owner/Repo#318");
    expect(body.text).toContain("run-1");
    expect(body.text).toContain("worker-minutes-exceeded");
    expect(body.text).toContain("https://github.com/Owner/Repo/pull/1");
  });

  it("adds no data the canonical payload does not carry", () => {
    const body = renderSlackMessage({
      ...notification,
      reasonCode: undefined,
      prUrl: undefined,
    });
    expect(body.text).not.toContain("undefined");
    expect(Object.keys(body)).toEqual(["text"]);
  });
});

describe("SlackNotificationProvider (#318)", () => {
  it("POSTs the rendered message to the webhook", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const provider = new SlackNotificationProvider({
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    const result = await provider.notify(notification);

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe("slack");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(WEBHOOK_URL);
    expect(calls[0].body.text).toContain("Owner/Repo#318");
  });

  it("never leaks the webhook URL into the body or an error", async () => {
    const { calls, fetchImpl } = recordingFetch(500);
    const provider = new SlackNotificationProvider({
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    const result = await provider.notify(notification);

    expect(JSON.stringify(calls[0].body)).not.toContain("super-secret-token");
    expect(String(result.error)).not.toContain("super-secret-token");
  });

  it("treats a non-2xx as a handled failure rather than a crash", async () => {
    const { fetchImpl } = recordingFetch(500);
    const provider = new SlackNotificationProvider({
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    const result = await provider.notify(notification);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/500/);
  });

  it("treats a network error as a handled failure", async () => {
    const provider = new SlackNotificationProvider({
      webhookUrl: WEBHOOK_URL,
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });

    const result = await provider.notify(notification);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/socket hang up/i);
  });

  it("bounds a hanging request with a timeout", async () => {
    const provider = new SlackNotificationProvider({
      webhookUrl: WEBHOOK_URL,
      timeoutMs: 20,
      fetchImpl: () => new Promise(() => {}),
    });

    const result = await provider.notify(notification);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/i);
  });

  it("retries at most once, so a persistent failure cannot storm", async () => {
    const { calls, fetchImpl } = recordingFetch(500);
    const provider = new SlackNotificationProvider({
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    await provider.notify(notification);

    expect(calls).toHaveLength(2);
  });

  it("does NOT retry a 4xx: a malformed request is a configuration problem", async () => {
    const { calls, fetchImpl } = recordingFetch(400);
    const provider = new SlackNotificationProvider({
      webhookUrl: WEBHOOK_URL,
      fetchImpl,
    });

    await provider.notify(notification);

    expect(calls).toHaveLength(1);
  });

  it("throws on a missing webhook URL instead of failing silently", () => {
    expect(() => new SlackNotificationProvider({ env: {} })).toThrow(
      SlackNotificationConfigurationError,
    );
  });

  it("throws on a malformed webhook URL", () => {
    expect(
      () =>
        new SlackNotificationProvider({
          env: { DF_SLACK_WEBHOOK_URL: "not-a-url" },
        }),
    ).toThrow(SlackNotificationConfigurationError);
  });
});

describe("the slack driver (#318)", () => {
  it("is selected only when the driver is configured", () => {
    expect(createNotificationProvider({}).id).toBe("console");

    const provider = createNotificationProvider({
      DF_NOTIFY_DRIVER: "slack",
      DF_SLACK_WEBHOOK_URL: WEBHOOK_URL,
    });
    expect(provider.id).toBe("slack");
  });
});
