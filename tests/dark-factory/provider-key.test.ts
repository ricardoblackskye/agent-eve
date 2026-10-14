import { describe, expect, it } from "vitest";
import { createInMemoryCredentialVault } from "../../agent/lib/dark-factory/credential-vault";
import { resolveProviderKey } from "../../agent/lib/dark-factory/provider-key";

describe("resolveProviderKey", () => {
  it("redeems the provider key server-side from the vault", async () => {
    const vault = createInMemoryCredentialVault({ allowList: ["llm-gateway"] });
    await vault.put("openrouter", "sk-live-secret");
    const key = await resolveProviderKey({ vault });
    expect(key).toBe("sk-live-secret");
  });

  it("fails closed when the credential is absent (and never leaks the secret)", async () => {
    const vault = createInMemoryCredentialVault({ allowList: ["llm-gateway"] });
    let leaked = "";
    try {
      await resolveProviderKey({ vault });
    } catch (e) {
      leaked = e instanceof Error ? e.message : String(e);
    }
    expect(leaked).not.toContain("sk-");
  });
});
