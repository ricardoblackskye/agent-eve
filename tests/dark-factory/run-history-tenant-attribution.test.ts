/**
 * Immutable run attribution at acceptance (#213, epic #212 R1).
 *
 * The tenant is resolved ONCE when a webhook delivery is accepted and stored on
 * the run. From then on it is write-once — a duplicate delivery reuses the
 * original assignment, and a later update (or a repository reassignment) cannot
 * rewrite a run's stored attribution. Unassigned is a genuine, preserved state.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import type { RunEvent } from "../../agent/lib/dark-factory/run-history";

const directories: string[] = [];
const stores: SqliteRunHistoryStore[] = [];
afterEach(() => {
  while (stores.length) (stores.pop() as SqliteRunHistoryStore).close();
  while (directories.length) rmSync(directories.pop() as string, { recursive: true, force: true });
});

function createStore(idFactory: () => string) {
  const directory = mkdtempSync(join(tmpdir(), "df-run-tenant-"));
  directories.push(directory);
  const store = new SqliteRunHistoryStore(join(directory, "runs.sqlite"), idFactory);
  stores.push(store);
  return store;
}

const AT = "2026-09-24T12:00:00.000Z";

function resumeEvent(runId: string): RunEvent {
  return {
    eventId: `evt-${runId}-resume`,
    runId,
    type: "run.resumed",
    stage: "trigger",
    occurredAt: AT,
    status: "running",
  };
}

describe("immutable run attribution", () => {
  it("persists the tenant once and never overwrites it on a later update", async () => {
    const TENANT = "11111111-1111-4111-8111-111111111111";
    const store = createStore(() => "run-1");
    const accepted = await store.acceptDelivery({
      deliveryId: "d1",
      repo: "owner/repo",
      issue: 1,
      receivedAt: AT,
      tenantId: TENANT,
    });
    expect(accepted.value?.tenantId).toBe(TENANT);

    // A later lifecycle event updates the summary via writeSummary, which
    // deliberately excludes tenant_id from its ON CONFLICT update.
    await store.appendEvent(resumeEvent("run-1"));
    const reloaded = await store.getRun("run-1");
    expect(reloaded.value?.tenantId).toBe(TENANT);
  });

  it("reuses the ORIGINAL assignment for a duplicate delivery, refusing to re-resolve", async () => {
    const FIRST = "22222222-2222-4222-8222-222222222222";
    const LATER = "33333333-3333-4333-8333-333333333333";
    const store = createStore(() => "run-2");
    const first = await store.acceptDelivery({
      deliveryId: "d2",
      repo: "owner/repo",
      issue: 2,
      receivedAt: AT,
      tenantId: FIRST,
    });
    expect(first.duplicate).toBe(false);
    expect(first.value?.tenantId).toBe(FIRST);

    // Same delivery replayed with a DIFFERENT tenant — must return the original
    // run and its original tenant, not re-derive from the (stale) input.
    const replay = await store.acceptDelivery({
      deliveryId: "d2",
      repo: "owner/repo",
      issue: 2,
      receivedAt: AT,
      tenantId: LATER,
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.value?.runId).toBe("run-2");
    expect(replay.value?.tenantId).toBe(FIRST);
  });

  it("keeps an unassigned run genuinely unassigned, not defaulted", async () => {
    const store = createStore(() => "run-3");
    await store.acceptDelivery({
      deliveryId: "d3",
      repo: "owner/repo",
      issue: 3,
      receivedAt: AT,
    });
    const accepted = await store.getRun("run-3");
    expect(accepted.value).not.toHaveProperty("tenantId");

    await store.appendEvent(resumeEvent("run-3"));
    const reloaded = await store.getRun("run-3");
    expect(reloaded.value).not.toHaveProperty("tenantId");
  });

  it("carries attribution across a store reopen (backfilled column)", async () => {
    const TENANT = "44444444-4444-4444-8444-444444444444";
    const directory = mkdtempSync(join(tmpdir(), "df-run-reopen-tenant-"));
    directories.push(directory);
    const path = join(directory, "runs.sqlite");
    const first = new SqliteRunHistoryStore(path, () => "durable");
    await first.acceptDelivery({
      deliveryId: "d4",
      repo: "owner/repo",
      issue: 4,
      receivedAt: AT,
      tenantId: TENANT,
    });
    first.close();

    const reopened = new SqliteRunHistoryStore(path);
    stores.push(reopened);
    const loaded = await reopened.getRun("durable");
    expect(loaded.value?.tenantId).toBe(TENANT);
  });
});
