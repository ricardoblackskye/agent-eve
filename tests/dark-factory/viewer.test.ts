import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, SESSION_COOKIE_NAME } from "../../app/auth-session";
import { InMemoryMembershipProvider } from "../../agent/lib/dark-factory/membership-store";
import { resolveViewer } from "../../app/api/dark-factory/viewer";

const SECRET = "test-secret-value-for-viewer-resolution";
const TENANT = "11111111-2222-4333-8444-555555555555";

function request(cookie?: string): Request {
  return new Request("http://localhost/api/dark-factory/runs", {
    headers: cookie ? { cookie } : {},
  });
}

async function sessionCookie(email: string): Promise<string> {
  const token = await createSessionToken({ email, secret: SECRET });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveViewer (#215)", () => {
  it("denies an unauthenticated request", async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    const outcome = await resolveViewer(request());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(401);
  });

  it("denies a signed-in email with no membership", async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    const store = new InMemoryMembershipProvider();
    const outcome = await resolveViewer(request(await sessionCookie("ghost@example.com")), {
      store,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
  });

  it("denies a suspended membership", async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    const store = new InMemoryMembershipProvider();
    await store.upsertMembership({ email: "sus@example.com", role: "operator" });
    await store.setMembershipStatus("sus@example.com", "suspended");

    const outcome = await resolveViewer(request(await sessionCookie("sus@example.com")), {
      store,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
  });

  it("resolves a customer to exactly their tenant", async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    const store = new InMemoryMembershipProvider();
    await store.upsertMembership({
      email: "customer@example.com",
      role: "customer",
      tenantId: TENANT,
    });

    const outcome = await resolveViewer(
      request(await sessionCookie("Customer@Example.com")),
      { store },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.viewer).toEqual({
      email: "customer@example.com",
      role: "customer",
      tenantId: TENANT,
    });
  });

  it("resolves an operator as unscoped", async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    const store = new InMemoryMembershipProvider();
    await store.upsertMembership({ email: "op@example.com", role: "operator" });

    const outcome = await resolveViewer(request(await sessionCookie("op@example.com")), {
      store,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.viewer).toEqual({ email: "op@example.com", role: "operator" });
    expect(outcome.viewer.tenantId).toBeUndefined();
  });

  it("fails closed when the membership store is not configured", async () => {
    vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
    // No injected store: the default factory is `console` without a driver set.
    vi.stubEnv("DF_MEMBERSHIP_DRIVER", "");
    const outcome = await resolveViewer(request(await sessionCookie("op@example.com")));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(403);
  });
});