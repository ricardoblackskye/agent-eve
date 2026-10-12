/**
 * #329 — the tenancy seam, end to end.
 *
 * `run-scope.test.ts` calls the query layer with a scope LITERAL, and
 * `run-query-api.test.ts` drives the real route behind a MOCKED `resolveViewer`. Neither drives the
 * real chain:
 *
 *   signed session cookie -> membership store -> tenantId -> route -> scoped result
 *
 * This file does, with the viewer unmocked and both stores real (SQLite), so a drift between the
 * real viewer object and a stub cannot hide a cross-tenant leak.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
} from "../../app/auth-session";
import { SqliteMembershipStore } from "../../agent/lib/dark-factory/membership-store-sqlite";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import * as detailRoute from "../../app/api/dark-factory/runs/[runId]/route";
import * as listRoute from "../../app/api/dark-factory/runs/route";

const SECRET = "tenancy-seam-e2e-secret";
const TENANT_A = "11111111-2222-4333-8444-555555555555";
const TENANT_B = "66666666-7777-4888-8999-000000000000";
const AT = "2026-10-12T09:00:00.000Z";

const dirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a sqlite file briefly after close; a temp dir is not worth failing on.
    }
  }
});

async function cookie(email: string): Promise<string> {
  const token = await createSessionToken({ email, secret: SECRET });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

/**
 * Seed BOTH real stores and point the route providers at them, then return the run ids.
 * The env is the only injection point the routes have (they call the providers themselves),
 * which is exactly why this test is a seam test: nothing is mocked.
 */
async function seedReality(): Promise<{
  mine: string;
  theirs: string;
  unattributed: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "df-seam-"));
  dirs.push(dir);
  const membershipPath = join(dir, "memberships.db");
  const historyPath = join(dir, "history.db");

  const memberships = new SqliteMembershipStore(membershipPath);
  await memberships.upsertMembership({
    email: "a@example.com",
    role: "customer",
    tenantId: TENANT_A,
  });
  await memberships.upsertMembership({
    email: "b@example.com",
    role: "customer",
    tenantId: TENANT_B,
  });
  await memberships.upsertMembership({
    email: "op@example.com",
    role: "operator",
  });
  await memberships.close?.();

  const ids = ["run-mine", "run-theirs", "run-unattributed"];
  let next = 0;
  const history = new SqliteRunHistoryStore(
    historyPath,
    () => ids[next++] as string,
  );
  await history.acceptDelivery({
    deliveryId: "d-mine",
    repo: "owner/repo",
    issue: 1,
    receivedAt: AT,
    tenantId: TENANT_A,
  });
  await history.acceptDelivery({
    deliveryId: "d-theirs",
    repo: "owner/repo",
    issue: 2,
    receivedAt: AT,
    tenantId: TENANT_B,
  });
  // No tenantId: an unattributed run must be invisible to every customer, visible to an operator.
  await history.acceptDelivery({
    deliveryId: "d-none",
    repo: "owner/repo",
    issue: 3,
    receivedAt: AT,
  });
  await history.close();

  vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
  vi.stubEnv("DF_MEMBERSHIP_DRIVER", "sqlite");
  vi.stubEnv("DF_MEMBERSHIP_DATABASE_PATH", membershipPath);
  vi.stubEnv("DF_RUN_HISTORY_DRIVER", "sqlite");
  vi.stubEnv("DF_RUN_HISTORY_DB_PATH", historyPath);

  return {
    mine: ids[0] as string,
    theirs: ids[1] as string,
    unattributed: ids[2] as string,
  };
}

function listRequest(cookieHeader: string, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/dark-factory/runs${query}`, {
    headers: { cookie: cookieHeader },
  });
}

function detailRequest(cookieHeader: string, runId: string): NextRequest {
  return new NextRequest(`http://localhost/api/dark-factory/runs/${runId}`, {
    headers: { cookie: cookieHeader },
  });
}

async function listRunIds(cookieHeader: string, query = ""): Promise<string[]> {
  const response = await listRoute.GET(listRequest(cookieHeader, query));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { runs: { runId: string }[] };
  return body.runs.map((run) => run.runId);
}

async function detail(cookieHeader: string, runId: string) {
  return detailRoute.GET(detailRequest(cookieHeader, runId), {
    params: Promise.resolve({ runId }),
  });
}

describe("#329 tenancy seam (real session -> real membership store -> route)", () => {
  it("scopes a customer's list to their own tenant, with foreign and unattributed runs present", async () => {
    const { mine } = await seedReality();
    const ids = await listRunIds(await cookie("a@example.com"));
    expect(ids).toEqual([mine]);
  });

  it("hides another tenant's run and never confirms it exists", async () => {
    const { theirs } = await seedReality();
    const a = await cookie("a@example.com");

    const foreign = await detail(a, theirs);
    const absent = await detail(a, "run-that-never-existed");
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    // Indistinguishable: same status AND same body, so the 404 cannot be used as an existence oracle.
    expect(await foreign.text()).toBe(await absent.text());
  });

  it("hides an unattributed run from every customer but shows it to an operator", async () => {
    const { mine, theirs, unattributed } = await seedReality();

    const customerIds = await listRunIds(await cookie("a@example.com"));
    expect(customerIds).not.toContain(unattributed);
    expect(customerIds).not.toContain(theirs);

    const operatorIds = await listRunIds(await cookie("op@example.com"));
    expect(operatorIds).toEqual(
      expect.arrayContaining([mine, theirs, unattributed]),
    );
  });

  it("lets a customer read their own run, and an operator read anyone's", async () => {
    const { mine, theirs } = await seedReality();

    const own = await detail(await cookie("a@example.com"), mine);
    expect(own.status).toBe(200);

    const operatorForeign = await detail(
      await cookie("op@example.com"),
      theirs,
    );
    expect(operatorForeign.status).toBe(200);
  });
});

/**
 * T2 — the scope-fill bound (`MAX_SCOPE_FILL_PAGES = 10`).
 *
 * A customer's list walks store pages to fill one page, because other tenants' runs interleave. The
 * walk must never surface a foreign run, and it must terminate.
 */
async function seedInterleaved(
  foreignCount: number,
): Promise<{ own: string[]; foreign: number }> {
  const dir = mkdtempSync(join(tmpdir(), "df-seam-fill-"));
  dirs.push(dir);
  const membershipPath = join(dir, "memberships.db");
  const historyPath = join(dir, "history.db");

  const memberships = new SqliteMembershipStore(membershipPath);
  await memberships.upsertMembership({
    email: "a@example.com",
    role: "customer",
    tenantId: TENANT_A,
  });
  await memberships.upsertMembership({
    email: "b@example.com",
    role: "customer",
    tenantId: TENANT_B,
  });
  await memberships.close?.();

  const ids: string[] = [];
  let next = 0;
  const history = new SqliteRunHistoryStore(historyPath, () => {
    const id = `run-${next++}`;
    ids.push(id);
    return id;
  });
  // Foreign runs first, each NEWER, so they occupy the leading pages the customer must walk past.
  for (let i = 0; i < foreignCount; i += 1) {
    await history.acceptDelivery({
      deliveryId: `d-foreign-${i}`,
      repo: "owner/repo",
      issue: 1000 + i,
      receivedAt: new Date(Date.parse(AT) + (i + 1) * 60_000).toISOString(),
      tenantId: TENANT_B,
    });
  }
  // The customer's own runs, older, so they sort LAST.
  const own: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const accepted = await history.acceptDelivery({
      deliveryId: `d-own-${i}`,
      repo: "owner/repo",
      issue: i + 1,
      receivedAt: new Date(Date.parse(AT) - (i + 1) * 60_000).toISOString(),
      tenantId: TENANT_A,
    });
    own.push(accepted.value?.runId as string);
  }
  await history.close();

  vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
  vi.stubEnv("DF_MEMBERSHIP_DRIVER", "sqlite");
  vi.stubEnv("DF_MEMBERSHIP_DATABASE_PATH", membershipPath);
  vi.stubEnv("DF_RUN_HISTORY_DRIVER", "sqlite");
  vi.stubEnv("DF_RUN_HISTORY_DB_PATH", historyPath);
  return { own, foreign: foreignCount };
}

describe("#329 scope-fill under interleaved tenants", () => {
  it("fills a customer's page from behind foreign runs without ever surfacing one", async () => {
    const { own } = await seedInterleaved(30); // > one 25-run page of foreign runs
    const ids = await listRunIds(await cookie("a@example.com"));
    expect(ids).toEqual(expect.arrayContaining(own));
    expect(ids.every((id) => own.includes(id))).toBe(true);
  });

  it("terminates and still never leaks when the interleaving exceeds the walk bound", async () => {
    // Page size 1, so 15 interleaved foreign runs already exceed MAX_SCOPE_FILL_PAGES (10) without
    // seeding hundreds of rows (a 300-run fixture was slow enough to brush the test timeout).
    const { own } = await seedInterleaved(15);
    const ids = await listRunIds(await cookie("a@example.com"), "?limit=1");
    // The bound may legitimately truncate the walk, so assert the SECURITY property, not the count:
    // nothing foreign is ever returned.
    expect(ids.every((id) => own.includes(id))).toBe(true);
  });
});
