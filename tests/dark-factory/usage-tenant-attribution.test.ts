/**
 * Tenant attribution on the usage ledger (#213, epic #212 R1).
 *
 * The two facts worth pinning: an attributed row keeps its tenant, and an
 * UNATTRIBUTED row stays genuinely absent — not defaulted, not empty-string,
 * because "unassigned" must be visible in reporting rather than silently
 * counted as somebody's usage.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  InvalidUsageEventError,
  toUsageEvent,
} from "../../agent/lib/dark-factory/usage-ledger";
import { SqliteUsageStore } from "../../agent/lib/dark-factory/usage-store-sqlite";

function base() {
  return {
    runId: "run-1",
    taskType: "orchestrator",
    model: "deepseek/deepseek-v4.1-flash",
    ts: "2026-10-01T10:00:00.000Z",
  };
}

describe("usage ledger tenant attribution", () => {
  it("preserves an attributed tenant id", () => {
    const tenantId = randomUUID();
    expect(toUsageEvent({ ...base(), tenantId }).tenantId).toBe(tenantId);
  });

  it("leaves tenantId ABSENT when the usage was not attributed", () => {
    expect(toUsageEvent(base())).not.toHaveProperty("tenantId");
  });

  it("rejects a blank tenant id rather than storing an empty owner", () => {
    expect(() => toUsageEvent({ ...base(), tenantId: "   " })).toThrow(
      InvalidUsageEventError,
    );
  });

  it("rejects a tenant id carrying control characters", () => {
    expect(() => toUsageEvent({ ...base(), tenantId: "abc\u0000def" })).toThrow(
      InvalidUsageEventError,
    );
  });

  it("rejects an over-long tenant id", () => {
    expect(() => toUsageEvent({ ...base(), tenantId: "x".repeat(257) })).toThrow(
      InvalidUsageEventError,
    );
  });
});

describe("sqlite usage store tenant persistence", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("stores the tenant id, and NULL for an unattributed row", async () => {
    dir = mkdtempSync(join(tmpdir(), "df-usage-tenant-"));
    const path = join(dir, "usage.sqlite");
    const store = new SqliteUsageStore(path, () => randomUUID());

    const tenantId = randomUUID();
    const attributed = await store.record(toUsageEvent({ ...base(), tenantId }));
    const unattributed = await store.record(
      toUsageEvent({ ...base(), runId: "run-2" }),
    );
    expect(attributed.ok && unattributed.ok).toBe(true);
    store.close();

    // Read the column directly: the aggregate view does not expose per-row
    // attribution, and the point here is what actually landed on disk.
    const db = new DatabaseSync(path);
    const rows = db
      .prepare("SELECT run_id, tenant_id FROM df_usage_events ORDER BY run_id")
      .all() as unknown as { run_id: string; tenant_id: string | null }[];
    db.close();

    expect(rows.length).toBe(2);
    expect(rows[0]?.run_id).toBe("run-1");
    expect(rows[0]?.tenant_id).toBe(tenantId);
    expect(rows[1]?.run_id).toBe("run-2");
    expect(rows[1]?.tenant_id).toBeNull();
  });
});