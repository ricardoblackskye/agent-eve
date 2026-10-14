import type {
  CredentialVault as SdkCredentialVault,
  CredentialVaultPatchRequest,
} from "@alibaba-group/opensandbox";

import type { CredentialVault } from "./credential-vault";

export interface OpenSandboxVaultDeps {
  /** A sandbox-local Credential Vault from the SDK (sandbox.credentialVault). */
  vault: SdkCredentialVault;
}

/**
 * #282 (R3/T1) — OpenSandbox-backed credential vault.
 *
 * The sandbox credential vault is WRITE-ONLY by design: the host stores a secret and binds it to a host
 * (the credential proxy injects it into the sandbox's outbound calls). The host therefore can NEVER read
 * the value back — `redeem` throws on purpose. This backend is for secrets the SANDBOX needs (e.g. a push
 * token, if the sandbox performs the git push); the GATEWAY's provider key stays in the host-side
 * `InMemoryCredentialVault`, which is the one that supports server-side `redeem`.
 *
 * Live use requires a vault-capable OpenSandbox server (the docker-example deployment currently 404s on
 * /credential-vault); until then this is SDK-typed and unit-tested against a fake vault.
 */
export function createOpenSandboxCredentialVault(
  deps: OpenSandboxVaultDeps,
): CredentialVault {
  const { vault } = deps;
  return {
    async put(name, value) {
      const req: CredentialVaultPatchRequest = {
        credentials: { add: [{ name, source: { value } }] },
      };
      await vault.patch(req);
    },
    async issueLease(name, scope) {
      // The binding name is the lease id; the credential proxy injects it into the sandbox.
      return { id: name, scope };
    },
    async redeem() {
      throw new Error(
        "OpenSandbox credential vault is write-only: the host cannot redeem a secret, it is injected into the sandbox via the credential proxy",
      );
    },
    async revoke(leaseId) {
      await vault.patch({ credentials: { delete: [leaseId] } });
    },
  };
}

/**
 * #354 — git's `basic` auth rule injects `Authorization: Basic <value>`, and the SDK documents that
 * value as the credential containing PRE-ENCODED `base64(username:password)`. So the host must encode
 * it before it enters the vault; the sandbox never sees either the token or this encoding.
 */
export function gitBasicCredentialValue(
  username: string,
  token: string,
): string {
  throw new Error("not implemented");
}

export interface GitPushCredentialOptions {
  /** Egress host the binding is scoped to, e.g. `github.com`. */
  host: string;
  /** Repo path the binding is scoped to, e.g. `/owner/repo.git*`. */
  path: string;
  /** The real push token. Never leaves the host except into the write-only vault. */
  token: string;
  /** Git username paired with the token; defaults to the GitHub App form `x-access-token`. */
  username?: string;
  credentialName?: string;
  bindingName?: string;
}

/**
 * #354 — provision the push token into the sandbox-local Credential Vault with a NARROW basic-auth
 * binding, so the sandbox's own `git push` carries no credential at all: the egress sidecar injects
 * the Authorization header for the matched repo path only.
 */
export async function provisionGitPushCredential(
  vault: SdkCredentialVault,
  opts: GitPushCredentialOptions,
): Promise<void> {
  throw new Error("not implemented");
}
