/**
 * Dark Factory — Slack notification adapter (#318).
 *
 * The first REAL driver for the notification seam (#317): Slack, via an **incoming webhook URL** —
 * no vendor SDK, no OAuth, no app registration. The seam, the payload and the wiring already exist;
 * this file is a driver only, so activating it is just `DF_NOTIFY_DRIVER=slack` plus the URL.
 *
 * SECRET DISCIPLINE: the webhook URL is a credential. It is never logged, never placed in the
 * request body, never written to the ledger, and never echoed in an error string. An absent or
 * malformed URL THROWS rather than failing silently — an operator must be told, not quietly
 * left without notifications.
 *
 * BEST-EFFORT and BOUNDED: the seam already swallows a delivery failure (a notification can never
 * fail a run), so this adapter returns `{ ok: false }` rather than throwing, bounds every attempt
 * with a timeout, and retries AT MOST ONCE — a 5xx/network/timeout may be transient, but a 4xx is a
 * configuration problem and retrying it would only double the noise.
 */

// TYPE-ONLY: erased at runtime, so the factory can import this class without a cycle, and the
// canonical Notification is used rather than the DOM's global of the same name.
import type {
  Notification,
  NotificationProvider,
  NotifyResult,
} from "./notifications";

/** Slack's incoming-webhook wire shape. The only thing this adapter may send. */
export interface SlackMessage {
  text: string;
}

export class SlackNotificationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackNotificationConfigurationError";
  }
}

/** The narrow fetch contract, injectable so tests need no network. */
export type SlackFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface SlackNotificationOptions {
  webhookUrl?: string;
  fetchImpl?: SlackFetch;
  env?: Record<string, string | undefined>;
  /** Per-attempt timeout. Defaults to 10s. */
  timeoutMs?: number;
}

export const DEFAULT_SLACK_TIMEOUT_MS = 10_000;
/** One initial attempt plus at most ONE retry. */
export const MAX_SLACK_ATTEMPTS = 2;

/**
 * Render the canonical notification for Slack. Built ONLY from the payload — no extra data, no free
 * text, no secret — and pure, so it is testable without a network.
 */
export function renderSlackMessage(notification: Notification): SlackMessage {
  const parts = [
    `Dark Factory: ${notification.kind}`,
    `${notification.repo}#${notification.issue}`,
    `run ${notification.runId}`,
    `status ${notification.status} (${notification.stage})`,
  ];
  if (notification.reasonCode !== undefined) {
    parts.push(`reason ${notification.reasonCode}`);
  }
  if (notification.prUrl !== undefined) {
    parts.push(notification.prUrl);
  }
  return { text: parts.join(" | ") };
}

function resolveWebhookUrl(
  webhookUrl: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const raw = (webhookUrl ?? env.DF_SLACK_WEBHOOK_URL ?? "").trim();
  if (raw === "") {
    throw new SlackNotificationConfigurationError(
      "DF_SLACK_WEBHOOK_URL is not set; refusing to construct the Slack channel (fail-closed).",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SlackNotificationConfigurationError(
      "DF_SLACK_WEBHOOK_URL must be a valid URL (received a malformed value).",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new SlackNotificationConfigurationError(
      "DF_SLACK_WEBHOOK_URL must use https.",
    );
  }
  return raw;
}

export class SlackNotificationProvider implements NotificationProvider {
  readonly id = "slack";
  readonly mode = "live" as const;

  private readonly url: string;
  private readonly fetchImpl: SlackFetch;
  private readonly timeoutMs: number;

  constructor(options: SlackNotificationOptions = {}) {
    const env = options.env ?? process.env;
    this.url = resolveWebhookUrl(options.webhookUrl, env);
    this.fetchImpl =
      options.fetchImpl ??
      (((
        url: string,
        init: { method: string; headers: Record<string, string>; body: string },
      ) => fetch(url, init)) as unknown as SlackFetch);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SLACK_TIMEOUT_MS;
  }

  async notify(notification: Notification): Promise<NotifyResult> {
    const body = JSON.stringify(renderSlackMessage(notification));
    let lastError = "Slack delivery failed.";

    for (let attempt = 1; attempt <= MAX_SLACK_ATTEMPTS; attempt++) {
      const outcome = await this.attempt(body);
      if (outcome.ok) return { ok: true, mode: "live", providerId: this.id };
      lastError = outcome.error;
      if (!outcome.retryable) break;
    }

    return { ok: false, mode: "live", providerId: this.id, error: lastError };
  }

  private async attempt(
    body: string,
  ): Promise<{ ok: boolean; retryable: boolean; error: string }> {
    try {
      const response = await this.withTimeout(
        this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
      if (response.ok) return { ok: true, retryable: false, error: "" };
      return {
        ok: false,
        // A 5xx may be transient; a 4xx is a malformed request and must not be repeated.
        retryable: response.status >= 500,
        error: `Slack returned HTTP ${response.status}.`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        retryable: true,
        error: `Slack delivery failed: ${message}`,
      };
    }
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    if (this.timeoutMs <= 0) return promise;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`Slack request timed out after ${this.timeoutMs}ms.`),
          ),
        this.timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
