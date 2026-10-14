import { randomBytes } from "node:crypto";

export interface LeaseScope {
  repos?: string[];
  expiresAt?: number; // epoch ms
}

export interface Lease {
  id: string;
  scope: LeaseScope;
}

export interface Adjudication {
  /** Adjudication only. Never carries the secret or any lease-state detail. */
  allowed: boolean;
}

export interface LeaseBroker {
  /** Issuance: returns an opaque lease. The secret is NEVER returned here. */
  issue(scope: LeaseScope): Lease;
  /** Adjudication only: allowed/denied. No secret, no lease-state oracle. */
  adjudicate(leaseId: string): Adjudication;
  /** Revoke. Revoking an absent lease is a no-op (404-as-success). */
  revoke(leaseId: string): void;
  /** Server-side redemption only — returns the secret. Never exposed to a client or sandbox. */
  redeem(leaseId: string): string;
}

export interface LeaseBrokerOptions {
  /** The secret this broker issues leases for (e.g. the provider key). */
  secret: string;
  /** Optional scope allow-list enforced at the seam; EMPTY => fail closed. */
  allowList?: string[];
  now?: () => number;
}

/**
 * #282 (R3/T4) — lease broker with issuance/adjudication separation.
 *
 * Issuance mints an opaque id; adjudication answers ONLY "allowed?" (one generic 401 at the HTTP layer,
 * never a state oracle); redemption is server-side only. The allow-list is enforced at this seam and
 * fails closed on empty. Revoking a missing lease is intentionally a no-op.
 */
export function createLeaseBroker(opts: LeaseBrokerOptions): LeaseBroker {
  const now = opts.now ?? (() => Date.now());
  const allow = new Set(opts.allowList ?? []);
  const store = new Map<string, { secret: string; scope: LeaseScope }>();

  const inScope = (scope: LeaseScope): boolean => {
    if (allow.size === 0) return false; // fail closed on empty allow-list
    if (scope.repos && scope.repos.length) return scope.repos.every((r) => allow.has(r));
    return true;
  };
  const notExpired = (scope: LeaseScope): boolean =>
    scope.expiresAt === undefined || scope.expiresAt >= now();

  return {
    issue(scope) {
      const id = randomBytes(18).toString("hex");
      store.set(id, { secret: opts.secret, scope });
      return { id, scope };
    },
    adjudicate(leaseId) {
      const rec = store.get(leaseId);
      if (!rec) return { allowed: false };
      if (!notExpired(rec.scope)) return { allowed: false };
      if (!inScope(rec.scope)) return { allowed: false };
      return { allowed: true };
    },
    revoke(leaseId) {
      store.delete(leaseId); // absent => no-op (404-as-success)
    },
    redeem(leaseId) {
      const rec = store.get(leaseId);
      if (!rec) throw new Error("lease not found");
      if (!notExpired(rec.scope)) throw new Error("lease expired");
      return rec.secret;
    },
  };
}
