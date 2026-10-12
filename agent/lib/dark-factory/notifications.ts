/**
 * Dark Factory — the notification seam (#317).
 *
 * A run's labels and comments are the record ON the ticket: they reach only someone already
 * looking. This is the missing **out-of-band push**, so a run's outcome reaches a human without
 * them polling.
 *
 * PROVIDER-NEUTRAL: a canonical, bounded payload plus a provider interface, so the channel (Slack,
 * email, …) is a seam choice rather than a rewrite — the same shape as the store / platform /
 * credential seams. The SEAM names no vendor: a channel arrives as a separate adapter module
 * (e.g. Slack, #318).
 *
 * The payload carries **no secrets and no free text**: bounded machine-readable fields only. The
 * run-history no-raw-content rule applies to this second egress point too — never the issue body,
 * never an answer, never a `DF_*` value.
 *
 * FAIL-CLOSED and OPT-IN: with nothing configured the default is a no-op that reports it is **not
 * configured** — it never claims a delivery it did not perform — and an unknown driver THROWS so a
 * typo surfaces instead of silently losing notifications.
 */

import { SlackNotificationProvider } from "./slack-notification";

/** The closed vocabulary of things worth telling a human about. */
export const NOTIFICATION_KINDS = [
  "started",
  "succeeded",
  "failed",
  "aborted",
  "parked",
  "tripped",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The run status vocabulary (kept in sync with `RunStatus`). */
const RUN_STATUSES = [
  "queued",
  "running",
  "blocked",
  "aborted",
  "succeeded",
  "failed",
] as const;

/** The stage vocabulary (kept in sync with `RunStage`). */
const RUN_STAGES = [
  "trigger",
  "dispatch",
  "worker",
  "review",
  "pull-request",
  "terminal",
] as const;

const MAX_IDENTIFIER_CHARS = 256;
const MAX_URL_CHARS = 512;

/** The canonical, bounded notification payload. Nothing else may be attached to it. */
export interface Notification {
  kind: NotificationKind;
  runId: string;
  repo: string;
  issue: number;
  status: (typeof RUN_STATUSES)[number];
  stage: (typeof RUN_STAGES)[number];
  /** A CLOSED, machine-readable code (e.g. a breaker trip reason). Never free text. */
  reasonCode?: string;
  prUrl?: string;
  occurredAt: string;
}

export interface NotificationInput {
  kind: NotificationKind;
  runId: string;
  repo: string;
  issue: number;
  status: (typeof RUN_STATUSES)[number];
  stage: (typeof RUN_STAGES)[number];
  reasonCode?: string;
  prUrl?: string;
  occurredAt: string;
}

export interface NotifyResult {
  ok: boolean;
  mode: "live" | "dry-run";
  providerId: string;
  error?: string;
}

export interface NotificationProvider {
  id: string;
  mode: "live" | "dry-run";
  notify(notification: Notification): Promise<NotifyResult>;
}

export class NotificationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationConfigurationError";
  }
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new NotificationConfigurationError(
      `Notification requires "${field}" to be a non-empty string.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new NotificationConfigurationError(
      `Notification "${field}" must be at most ${max} characters (received ${trimmed.length}).`,
    );
  }
  return trimmed;
}

function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new NotificationConfigurationError(
      `Notification "${field}" must be one of ${allowed.join(", ")}.`,
    );
  }
  return value as T;
}

/**
 * Validate and copy one notification. Unknown input fields are DROPPED, so the payload cannot be
 * used to smuggle free text onto the channel.
 */
export function toNotification(input: NotificationInput): Notification {
  const kind = oneOf(input.kind, "kind", NOTIFICATION_KINDS);
  const runId = requiredText(input.runId, "runId", MAX_IDENTIFIER_CHARS);
  const repo = requiredText(input.repo, "repo", MAX_IDENTIFIER_CHARS);
  const status = oneOf(input.status, "status", RUN_STATUSES);
  const stage = oneOf(input.stage, "stage", RUN_STAGES);
  const occurredAt = requiredText(
    input.occurredAt,
    "occurredAt",
    MAX_IDENTIFIER_CHARS,
  );

  if (!Number.isInteger(input.issue) || input.issue <= 0) {
    throw new NotificationConfigurationError(
      `Notification "issue" must be a positive integer (received ${String(input.issue)}).`,
    );
  }

  const reasonCode =
    input.reasonCode === undefined
      ? undefined
      : requiredText(input.reasonCode, "reasonCode", MAX_IDENTIFIER_CHARS);
  const prUrl =
    input.prUrl === undefined
      ? undefined
      : requiredText(input.prUrl, "prUrl", MAX_URL_CHARS);

  return {
    kind,
    runId,
    repo,
    issue: input.issue,
    status,
    stage,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
    occurredAt,
  };
}

/**
 * The fail-closed default: renders locally, sends nothing, needs no credential — and says so.
 * `ok: false` is the honest answer: nothing was delivered.
 */
export class ConsoleNotificationProvider implements NotificationProvider {
  id = "console";
  mode = "dry-run" as const;

  async notify(notification: Notification): Promise<NotifyResult> {
    const valid = toNotification(notification);
    console.log(
      `[df-notify:console] ${valid.kind} ${valid.repo}#${valid.issue} (run ${valid.runId})`,
    );
    return {
      ok: false,
      mode: "dry-run",
      providerId: this.id,
      error: "Notification provider is not configured.",
    };
  }
}

const SUPPORTED_DRIVERS = "console, slack (leave unset for the no-op default)";

/**
 * Select the notification provider.
 *
 * Unset (or `console`) => the no-op default, which delivers nothing and says so. An unknown driver
 * THROWS rather than degrading silently, so a typo is a clear configuration error instead of
 * notifications quietly going nowhere.
 */
export function createNotificationProvider(
  env: Record<string, string | undefined> = process.env,
): NotificationProvider {
  const driver = (env.DF_NOTIFY_DRIVER ?? "").trim().toLowerCase();
  if (driver === "" || driver === "console") {
    return new ConsoleNotificationProvider();
  }
  if (driver === "slack") {
    // The URL is validated by the adapter: a missing or malformed one THROWS, so a misconfiguration
    // is a loud error rather than notifications quietly going nowhere.
    return new SlackNotificationProvider({ env });
  }
  throw new NotificationConfigurationError(
    `Unknown DF_NOTIFY_DRIVER '${driver}'. Supported drivers: ${SUPPORTED_DRIVERS}.`,
  );
}

/**
 * Whether a REAL channel is configured. Callers use this to decide whether to pay any cost at all:
 * with no channel the seam is inert, exactly like the unconfigured usage ledger.
 */
export function isNotificationsConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const driver = (env.DF_NOTIFY_DRIVER ?? "").trim().toLowerCase();
  return driver !== "" && driver !== "console";
}
