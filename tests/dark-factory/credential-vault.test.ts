import { describe, expect, it } from "vitest";
import { createInMemoryCredentialVault } from "../../agent/lib/dark-factory/credential-vault";

describe("createInMemoryCredentialVault", () => {
  it("is write-only: the value is never returned by put/issueLease, only by server-side redeem", async () => {
    const vault = createInMemoryCredentialVault({ allowList: ["repo:a"] });
    await vault.put("provider-key", "sk-ultra-secret");
    const lease = await vault.issueLease("provider-key", { repos: ["repo:a"] });
    // the lease returned to a caller must not contain the secret
    expect(Object.keys(lease)).toEqual(["id", "scope"]);
    expect(JSON.stringify(lease)).not.toContain("sk-ultra-secret");
    // only server-side redemption (never handed to a client/sandbox) returns it
    expect(await vault.redeem(lease.id)).toBe("sk-ultra-secret");
  });

  it("redeem throws for an unknown lease (never leaks a hint)", async () => {
    const vault = createInMemoryCredentialVault({ allowList: ["repo:a"] });
    await expect(vault.redeem("nope")).rejects.toThrow();
  });

  it("revoke of an absent lease is a no-op (404-as-success)", async () => {
    const vault = createInMemoryCredentialVault({ allowList: ["repo:a"] });
    await expect(vault.revoke("nope")).resolves.toBeUndefined();
  });

  it("fails closed when the allow-list is empty", async () => {
    const vault = createInMemoryCredentialVault();
    await vault.put("provider-key", "sk-x");
    await expect(
      vault.issueLease("provider-key", { repos: ["repo:a"] }),
    ).rejects.toThrow();
  });
});
