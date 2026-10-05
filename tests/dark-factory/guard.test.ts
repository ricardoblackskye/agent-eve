import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
} from "../../app/auth-session";
import { InMemoryMembershipProvider } from "../../agent/lib/dark-factory/membership-store";

const holder = vi.hoisted(() => ({ store: null as unknown }));

// The guard is exercised for real; only the store it resolves against is
// swapped, so the session check, the role check and the scope all run.
vi.mock(
  "../../agent/lib/dark-factory/membership-store",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../agent/lib/dark-factory/membership-store")
      >();
    return { ...actual, createMembershipStore: () => holder.store };
  },
);

import { guardOperator, guardViewer } from "../../app/api/dark-factory/guard";

const secret = "test-guard-session";
const TENANT_A = "11111111-2222-4333-8444-555555555555";

function store(): InMemoryMembershipProvider {
  return new InMemoryMembershipProvider();
}

async function request(email: string): Promise<Request> {
  const token = await createSessionToken({ email, secret });
  return new Request("https://eve.local/api/dark-factory/runs", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

beforeEach(() => {
  process.env.AUTH_SESSION_SECRET = secret;
  holder.store = store();
});

describe("route guard (#215)", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const result = await guardViewer(
      new Request("https://eve.local/api/dark-factory/runs") as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
  });

  it("refuses a signed-in account with no membership", async () => {
    const result = await guardViewer(
      (await request("ghost@example.com")) as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
  });

  it("refuses a suspended membership", async () => {
    const store = holder.store as InMemoryMembershipProvider;
    await store.upsertMembership({
      email: "suspended@example.com",
      role: "operator",
      status: "suspended",
    });
    const result = await guardViewer(
      (await request("suspended@example.com")) as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
  });

  it("admits an active operator to an operator-only route", async () => {
    const store = holder.store as InMemoryMembershipProvider;
    await store.upsertMembership({
      email: "operator@example.com",
      role: "operator",
    });
    const result = await guardOperator(
      (await request("operator@example.com")) as never,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.viewer.role).toBe("operator");
  });

  it("refuses a customer at an operator-only route", async () => {
    const store = holder.store as InMemoryMembershipProvider;
    await store.upsertMembership({
      email: "customer@example.com",
      role: "customer",
      tenantId: TENANT_A,
    });
    const result = await guardOperator(
      (await request("customer@example.com")) as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
  });

  it("admits a customer with exactly their own tenant scope", async () => {
    const store = holder.store as InMemoryMembershipProvider;
    await store.upsertMembership({
      email: "customer@example.com",
      role: "customer",
      tenantId: TENANT_A,
    });
    const result = await guardViewer(
      (await request("customer@example.com")) as never,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.viewer.role).toBe("customer");
    expect(result.viewer.tenantId).toBe(TENANT_A);
  });
});
