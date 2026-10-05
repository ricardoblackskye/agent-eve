import { describe, expect, it } from "vitest";
import {
  InvalidMembershipError,
  isMembershipActive,
  membershipScope,
  normalizeEmail,
  validateMembership,
} from "../../agent/lib/dark-factory/membership";
import {
  ConsoleMembershipProvider,
  InMemoryMembershipProvider,
  createMembershipStore,
} from "../../agent/lib/dark-factory/membership-store";

describe("membership model (#215)", () => {
  it("normalises an email to a single canonical key", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("rejects an email that is not an email", () => {
    expect(() => normalizeEmail("not-an-email")).toThrow(InvalidMembershipError);
  });

  it("requires a tenant for a customer but not for an operator", () => {
    expect(() =>
      validateMembership({ email: "c@example.com", role: "customer" }),
    ).toThrow(InvalidMembershipError);

    const operator = validateMembership({ email: "o@example.com", role: "operator" });
    expect(operator.role).toBe("operator");
    expect(operator.tenantId).toBeUndefined();
  });

  it("rejects a customer scoped to a non-UUID tenant", () => {
    expect(() =>
      validateMembership({
        email: "c@example.com",
        role: "customer",
        tenantId: "acme",
      }),
    ).toThrow(InvalidMembershipError);
  });

  it("treats anything that is not active as unable to act", () => {
    expect(isMembershipActive({ status: "active" })).toBe(true);
    expect(isMembershipActive({ status: "suspended" })).toBe(false);
  });

  it("gives an operator no tenant scope and a customer exactly one", () => {
    const tenantId = "11111111-2222-4333-8444-555555555555";
    expect(
      membershipScope(validateMembership({ email: "o@example.com", role: "operator" })),
    ).toEqual({ role: "operator" });
    expect(
      membershipScope(
        validateMembership({ email: "c@example.com", role: "customer", tenantId }),
      ),
    ).toEqual({ role: "customer", tenantId });
  });
});

describe("membership store seam (#215)", () => {
  it("is fail-closed in console mode", async () => {
    const store = new ConsoleMembershipProvider();
    const read = await store.getMembership("someone@example.com");
    expect(read.ok).toBe(false);
    const write = await store.upsertMembership({
      email: "someone@example.com",
      role: "operator",
    });
    expect(write.ok).toBe(false);
  });

  it("upserts, resolves and suspends in memory", async () => {
    const store = new InMemoryMembershipProvider();
    const tenantId = "11111111-2222-4333-8444-555555555555";

    const created = await store.upsertMembership({
      email: "  Customer@Example.com ",
      role: "customer",
      tenantId,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.email).toBe("customer@example.com");

    const found = await store.getMembership("CUSTOMER@example.com");
    expect(found.ok && found.value?.tenantId).toBe(tenantId);

    const suspended = await store.setMembershipStatus(
      "customer@example.com",
      "suspended",
    );
    expect(suspended.ok && suspended.value.status).toBe("suspended");

    const missing = await store.getMembership("nobody@example.com");
    expect(missing.ok && missing.value).toBeNull();
  });

  it("fails closed on an unknown driver", () => {
    expect(() => createMembershipStore({ DF_MEMBERSHIP_DRIVER: "mysql" })).toThrow(
      /DF_MEMBERSHIP_DRIVER/,
    );
  });
});