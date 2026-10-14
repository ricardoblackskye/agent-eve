import { describe, expect, it, vi } from "vitest";
import { createOpenSandboxCredentialVault } from "../../agent/lib/dark-factory/opensandbox-credential-vault";
import type { CredentialVault as SdkCredentialVault } from "@alibaba-group/opensandbox";

function fakeSdkVault() {
  return {
    patch: vi.fn(
      async (_req: unknown) =>
        ({}) as unknown as SdkCredentialVault extends never
          ? never
          : { revision: 1; bindings: [] },
    ),
  } as unknown as SdkCredentialVault;
}

describe("createOpenSandboxCredentialVault", () => {
  it("writes the secret via a patch (add) and never reads it back", async () => {
    const sdk = fakeSdkVault();
    const vault = createOpenSandboxCredentialVault({ vault: sdk });
    await vault.put("provider-key", "sk-secret");
    expect(
      (sdk as unknown as { patch: ReturnType<typeof vi.fn> }).patch,
    ).toHaveBeenCalledWith({
      credentials: {
        add: [{ name: "provider-key", source: { value: "sk-secret" } }],
      },
    });
    // write-only: the host cannot redeem (the proxy injects it into the sandbox instead)
    await expect(vault.redeem("provider-key")).rejects.toThrow(/write-only/);
  });

  it("revoke patches a delete", async () => {
    const sdk = fakeSdkVault();
    const vault = createOpenSandboxCredentialVault({ vault: sdk });
    await vault.revoke("provider-key");
    expect(
      (sdk as unknown as { patch: ReturnType<typeof vi.fn> }).patch,
    ).toHaveBeenCalledWith({
      credentials: { delete: ["provider-key"] },
    });
  });
});
