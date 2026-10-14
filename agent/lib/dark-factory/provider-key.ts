import type { CredentialVault } from "./credential-vault";

export interface ProviderKeyResolverDeps {
  vault: CredentialVault;
  credentialName?: string;
  scope?: { repos?: string[] };
}

/**
 * #282 (R3/T1) — server-side retrieval of the model-provider key.
 *
 * The key is stored write-only in the credential vault; this issues + redeems a lease to get it back,
 * and NEVER hands it to a client or sandbox. Called only inside `forwardUpstream` (the gateway process).
 * If the vault has no such credential, it throws — that is the fail-closed path (no key => no forward).
 */
export async function resolveProviderKey(deps: ProviderKeyResolverDeps): Promise<string> {
  const name = deps.credentialName ?? "openrouter";
  const lease = await deps.vault.issueLease(name, deps.scope ?? { repos: ["llm-gateway"] });
  return deps.vault.redeem(lease.id);
}
