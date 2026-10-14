import {
  createLeaseBroker,
  type LeaseBroker,
  type LeaseScope,
} from "./lease-broker";

export interface CredentialVault {
  /** Write-only store. The value is never readable back through the public API. */
  put(name: string, value: string): Promise<void>;
  /** Issue an opaque lease for a stored credential, scoped to `scope`. */
  issueLease(
    name: string,
    scope: LeaseScope,
  ): Promise<{ id: string; scope: LeaseScope }>;
  /** Server-side redemption only — returns the value. Never handed to a client/sandbox. */
  redeem(leaseId: string): Promise<string>;
  /** Revoke a lease; an absent lease is a no-op (404-as-success). */
  revoke(leaseId: string): Promise<void>;
}

export interface InMemoryCredentialVaultOptions {
  allowList?: string[];
  now?: () => number;
}

/**
 * #282 (R3/T1) — write-only credential vault.
 *
 * The secret lives only in this object's private `Map`; there is NO read-back method other than
 * server-side `redeem`, which is called by the gateway (never by a sandbox or client). This is what keeps
 * the provider key out of env, argv, logs, metrics and errors. The real OpenSandbox-backed vault
 * (`opensandbox-credential-vault.ts`) satisfies the same interface when a vault-capable server exists.
 */
export function createInMemoryCredentialVault(
  opts: InMemoryCredentialVaultOptions = {},
): CredentialVault {
  const secrets = new Map<string, string>();
  const brokers = new Map<string, LeaseBroker>();

  return {
    async put(name, value) {
      secrets.set(name, value);
    },
    async issueLease(name, scope) {
      // Fail closed: with no allow-list there is no valid scope to lease against, so issuance is refused.
      if (!opts.allowList || opts.allowList.length === 0) {
        throw new Error(
          "credential vault allow-list is empty: refusing to issue a lease (fail-closed)",
        );
      }
      const secret = secrets.get(name);
      if (secret === undefined)
        throw new Error(`credential not found: ${name}`);
      const broker = createLeaseBroker({
        secret,
        allowList: opts.allowList,
        now: opts.now,
      });
      const lease = broker.issue(scope);
      brokers.set(lease.id, broker);
      return { id: lease.id, scope: lease.scope };
    },
    async redeem(leaseId) {
      const broker = brokers.get(leaseId);
      if (!broker) throw new Error("lease not found");
      return broker.redeem(leaseId);
    },
    async revoke(leaseId) {
      brokers.delete(leaseId); // absent => no-op
    },
  };
}
