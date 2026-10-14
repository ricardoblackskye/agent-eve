import { describe, expect, it } from "vitest";
import { createLeaseBroker } from "../../agent/lib/dark-factory/lease-broker";

describe("createLeaseBroker", () => {
  it("issues an opaque lease that does NOT contain the secret", () => {
    const broker = createLeaseBroker({
      secret: "super-secret-key",
      allowList: ["repo:a"],
    });
    const lease = broker.issue({ repos: ["repo:a"] });
    expect(lease.id).toBeTruthy();
    expect(lease.id).not.toContain("super-secret-key");
    // the lease surface must never carry the secret
    expect(Object.keys(lease)).toEqual(["id", "scope"]);
    expect(JSON.stringify(lease)).not.toContain("super-secret-key");
  });

  it("adjudicates allowed when in allow-list and unexpired", () => {
    const broker = createLeaseBroker({ secret: "k", allowList: ["repo:a"] });
    const lease = broker.issue({ repos: ["repo:a"] });
    expect(broker.adjudicate(lease.id)).toEqual({ allowed: true });
  });

  it("adjudicates denied for a lease whose scope is not in the allow-list (even if it exists)", () => {
    const broker = createLeaseBroker({ secret: "k", allowList: ["repo:a"] });
    const lease = broker.issue({ repos: ["repo:b"] });
    expect(broker.adjudicate(lease.id)).toEqual({ allowed: false });
  });

  it("fails closed when the allow-list is empty", () => {
    const broker = createLeaseBroker({ secret: "k" });
    const lease = broker.issue({ repos: ["repo:a"] });
    expect(broker.adjudicate(lease.id)).toEqual({ allowed: false });
  });

  it("fails closed on an expired lease", () => {
    const now = () => 1_000;
    const broker = createLeaseBroker({
      secret: "k",
      allowList: ["repo:a"],
      now,
    });
    const lease = broker.issue({ repos: ["repo:a"], expiresAt: 999 });
    expect(broker.adjudicate(lease.id)).toEqual({ allowed: false });
  });

  it("adjudication result carries NO state oracle (only `allowed`)", () => {
    const broker = createLeaseBroker({ secret: "k", allowList: ["repo:a"] });
    const lease = broker.issue({ repos: ["repo:a"] });
    const result = broker.adjudicate(lease.id);
    expect(Object.keys(result)).toEqual(["allowed"]);
  });

  it("revoking an absent lease is a no-op (404-as-success)", () => {
    const broker = createLeaseBroker({ secret: "k", allowList: ["repo:a"] });
    expect(() => broker.revoke("does-not-exist")).not.toThrow();
  });

  it("redeems server-side only and throws for an absent lease", () => {
    const broker = createLeaseBroker({
      secret: "super-secret-key",
      allowList: ["repo:a"],
    });
    const lease = broker.issue({ repos: ["repo:a"] });
    expect(broker.redeem(lease.id)).toBe("super-secret-key");
    expect(() => broker.redeem("missing")).toThrow();
  });
});
