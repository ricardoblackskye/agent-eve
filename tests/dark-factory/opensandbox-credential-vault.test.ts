import { describe, expect, it, vi } from "vitest";
import {
  createOpenSandboxCredentialVault,
  gitBasicCredentialValue,
  provisionGitPushCredential,
} from "../../agent/lib/dark-factory/opensandbox-credential-vault";
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

/**
 * #354 — the push token reaches the sandbox ONLY as a vault binding, never as env/argv/a URL.
 *
 * The sidecar's `basic` rule injects the Authorization header itself, so the sandbox runs a bare
 * `git push https://github.com/owner/repo.git` with no credential of its own. That makes the binding
 * the single place the secret exists at push time, which is exactly what the AC inspects for.
 */
describe("#354 git push credential provisioning", () => {
  // Deliberately NOT token-shaped: a `ghp_`-prefixed literal would trip secretlint in CI.
  const token = "fixture-push-token-value";
  const expectedBasic = Buffer.from(`x-access-token:${token}`).toString("base64");

  function fakeCreateVault() {
    const create = vi.fn(async (_req: unknown) => ({
      revision: 1,
      credentials: [],
      bindings: [],
    }));
    const patch = vi.fn(async (_req: unknown) => ({
      revision: 1,
      credentials: [],
      bindings: [],
    }));
    return { create, patch } as unknown as SdkCredentialVault & {
      create: ReturnType<typeof vi.fn>;
    };
  }

  it("base64-encodes username:token, as the basic auth rule requires", () => {
    expect(gitBasicCredentialValue("x-access-token", token)).toBe(expectedBasic);
  });

  it("creates the credential and a narrow basic-auth binding scoped to the repo path", async () => {
    const sdk = fakeCreateVault();
    await provisionGitPushCredential(sdk, {
      host: "github.com",
      path: "/ricardoblackskye/agent-eve.git*",
      token,
    });
    expect(sdk.create).toHaveBeenCalledTimes(1);
    const req = sdk.create.mock.calls[0]![0];
    expect(req).toEqual({
      credentials: [
        { name: "git-push-token", source: { value: expectedBasic } },
      ],
      bindings: [
        {
          name: "git-push",
          match: {
            schemes: ["https"],
            hosts: ["github.com"],
            paths: ["/ricardoblackskye/agent-eve.git*"],
          },
          auth: { type: "basic", credential: "git-push-token" },
        },
      ],
    });
    // The RAW token must never appear in the request: only its basic-auth encoding.
    expect(JSON.stringify(req)).not.toContain(token);
  });

  it("refuses a blank token, provisioning nothing (fail-closed)", async () => {
    const sdk = fakeCreateVault();
    await expect(
      provisionGitPushCredential(sdk, {
        host: "github.com",
        path: "/a/b.git*",
        token: "   ",
      }),
    ).rejects.toThrow(/token/i);
    expect(sdk.create).not.toHaveBeenCalled();
  });
});
