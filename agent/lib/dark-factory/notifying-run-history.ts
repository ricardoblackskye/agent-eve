/**
 * Dark Factory — drive notifications from the ledger (#317).
 *
 * Every write path in the factory — the webhook dispatch, `worker-reporter`, the runner, the
 * terminal finalizer and the breaker-trip recorder — reaches the run history through
 * `RunHistoryStore`. So this **decorates the store** and inspects each write, which means no
 * lifecycle site needs a call and **no path can be forgotten** (the failure mode that produced
 * three dead seams already).
 *
 * IDEMPOTENT: a transition is announced once. The ledger's `duplicate` flag is the primary guard
 * and a bounded in-process set of `(runId, eventId)` backs it up, so a re-delivered webhook or a
 * retried run cannot spam the channel. The set is deliberately bounded and per-process — the
 * durable identity is the ledger's event id.
 *
 * BEST-EFFORT: a notification can never fail a run. Every suppression is logged, never silent.
 */
import type { RunEvent, RunStage, RunStatus, RunSummary } from "./run-history";
import {
  createNotificationProvider,
  isNotificationsConfigured,
  toNotification,
  type Notification,
  type NotificationKind,
  type NotificationProvider,
} from "./notifications";
import type { RunHistoryStore } from "./run-history-store";

/** Bound on the in-process idempotency guard, so a long-lived process cannot grow unbounded. */
export const MAX_REMEMBERED_TRANSITIONS = 1000;

/**
 * Which notification, if any, an appended event represents. Pure, so it is testable in isolation.
 */
export function notificationKindFor(event: RunEvent): NotificationKind | null {
  // A trip is the most specific thing that can be said about an event, so it wins.
  if (event.breakerTrip !== undefined) return "tripped";
  if (event.type === "run.accepted") return "started";
  if (event.type === "worker.question") return "parked";
  if (event.type === "run.terminal") {
    if (event.status === "succeeded") return "succeeded";
    if (event.status === "failed") return "failed";
    if (event.status === "aborted") return "aborted";
  }
  return null;
}

export interface NotifyingRunHistoryOptions {
  /** Sink for the honest reporting; defaults to `console.error`. */
  log?: (message: string) => void;
}

export class NotifyingRunHistoryStore implements RunHistoryStore {
  readonly id: string;
  private readonly remembered = new Set<string>();

  constructor(
    private readonly inner: RunHistoryStore,
    private readonly provider: NotificationProvider,
    private readonly options: NotifyingRunHistoryOptions = {},
  ) {
    this.id = inner.id;
  }

  private log(message: string): void {
    (this.options.log ?? ((line: string) => console.error(line)))(message);
  }

  /** True when this transition has already been announced (or is now remembered). */
  private seen(key: string): boolean {
    if (this.remembered.has(key)) return true;
    if (this.remembered.size >= MAX_REMEMBERED_TRANSITIONS) {
      const oldest = this.remembered.values().next().value;
      if (oldest !== undefined) this.remembered.delete(oldest);
    }
    this.remembered.add(key);
    return false;
  }

  private async announce(
    kind: NotificationKind,
    summary: RunSummary,
    fields: {
      status: RunStatus;
      stage: RunStage;
      occurredAt: string;
      eventId: string;
    },
    extras: { reasonCode?: string; prUrl?: string } = {},
    duplicate?: boolean,
  ): Promise<void> {
    if (duplicate === true) return;
    if (this.seen(`${summary.runId}:${fields.eventId}`)) return;

    const notification: Notification = toNotification({
      kind,
      runId: summary.runId,
      repo: summary.repo,
      issue: summary.issue,
      status: fields.status,
      stage: fields.stage,
      occurredAt: fields.occurredAt,
      ...(extras.reasonCode !== undefined
        ? { reasonCode: extras.reasonCode }
        : {}),
      ...(extras.prUrl !== undefined ? { prUrl: extras.prUrl } : {}),
    });

    try {
      const result = await this.provider.notify(notification);
      if (!result.ok) {
        this.log(
          `[WARN] Notification '${kind}' was not delivered for ${summary.runId}: ` +
            `${result.error ?? "the provider refused it"}.`,
        );
      }
    } catch (error) {
      // A notification must never fail a run.
      this.log(
        `[WARN] Notification '${kind}' failed for ${summary.runId}: ` +
          `${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }

  async acceptDelivery(
    input: Parameters<RunHistoryStore["acceptDelivery"]>[0],
  ): ReturnType<RunHistoryStore["acceptDelivery"]> {
    const result = await this.inner.acceptDelivery(input);
    if (result.ok && result.value) {
      await this.announce(
        "started",
        result.value,
        {
          status: result.value.status,
          stage: result.value.stage,
          occurredAt: result.value.createdAt,
          eventId: `accepted:${input.deliveryId}`,
        },
        {},
        result.duplicate,
      );
    }
    return result;
  }

  async appendEvent(
    event: RunEvent,
  ): ReturnType<RunHistoryStore["appendEvent"]> {
    const result = await this.inner.appendEvent(event);
    if (result.ok && result.value) {
      const kind = notificationKindFor(event);
      if (kind !== null) {
        await this.announce(
          kind,
          result.value,
          {
            status: result.value.status,
            stage: event.stage,
            occurredAt: event.occurredAt,
            eventId: event.eventId,
          },
          {
            ...(event.breakerTrip !== undefined
              ? { reasonCode: event.breakerTrip.reason }
              : {}),
            ...(event.prUrl !== undefined ? { prUrl: event.prUrl } : {}),
          },
          result.duplicate,
        );
      }
    }
    return result;
  }

  // --- everything else is a straight delegation; the seam only observes WRITES ---

  claimControlDelivery(
    ...args: Parameters<RunHistoryStore["claimControlDelivery"]>
  ) {
    return this.inner.claimControlDelivery(...args);
  }

  advanceControlDelivery(
    ...args: Parameters<RunHistoryStore["advanceControlDelivery"]>
  ) {
    return this.inner.advanceControlDelivery(...args);
  }

  updateCommentReference(
    ...args: Parameters<RunHistoryStore["updateCommentReference"]>
  ) {
    return this.inner.updateCommentReference(...args);
  }

  recordRunSummary(...args: Parameters<RunHistoryStore["recordRunSummary"]>) {
    return this.inner.recordRunSummary(...args);
  }

  /** #404 R2 — delegated like every other write, so a decorated store cannot silently lose the capability. */
  retireRunClaim(...args: Parameters<RunHistoryStore["retireRunClaim"]>) {
    return this.inner.retireRunClaim(...args);
  }

  getRun(...args: Parameters<RunHistoryStore["getRun"]>) {
    return this.inner.getRun(...args);
  }

  listRuns(...args: Parameters<RunHistoryStore["listRuns"]>) {
    return this.inner.listRuns(...args);
  }

  listRunEvents(...args: Parameters<RunHistoryStore["listRunEvents"]>) {
    return this.inner.listRunEvents(...args);
  }

  getRunMetrics(...args: Parameters<RunHistoryStore["getRunMetrics"]>) {
    return this.inner.getRunMetrics(...args);
  }

  // #486 — the plan ledger is part of the store contract, so a decorated store must not lose it.
  recordPlan(...args: Parameters<RunHistoryStore["recordPlan"]>) {
    return this.inner.recordPlan(...args);
  }

  listPlans(...args: Parameters<RunHistoryStore["listPlans"]>) {
    return this.inner.listPlans(...args);
  }

  recordPlanEstimate(...args: Parameters<RunHistoryStore["recordPlanEstimate"]>) {
    return this.inner.recordPlanEstimate(...args);
  }

  listPlanEstimates(...args: Parameters<RunHistoryStore["listPlanEstimates"]>) {
    return this.inner.listPlanEstimates(...args);
  }

  listEstimateAccuracy(...args: Parameters<RunHistoryStore["listEstimateAccuracy"]>) {
    return this.inner.listEstimateAccuracy(...args);
  }

  close() {
    return this.inner.close();
  }
}

/**
 * Wrap a run-history store so its transitions are announced (#317).
 *
 * Transparent and OPT-IN: with no channel configured the store is returned **unchanged**, so an
 * unconfigured deployment pays nothing and cannot be broken by this seam. A configured driver is
 * constructed — and a TYPO in it throws, rather than silently sending notifications nowhere.
 *
 * This is the ONE place the app wraps a store: readers take the plain store, and the seed/control
 * paths do not wrap at all because they write no run transitions.
 */
export function withNotifications(
  history: RunHistoryStore,
  env: Record<string, string | undefined> = process.env,
): RunHistoryStore {
  if (!isNotificationsConfigured(env)) return history;
  return new NotifyingRunHistoryStore(history, createNotificationProvider(env));
}
