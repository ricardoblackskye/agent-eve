/**
 * Dark Factory — customer membership model (#215, epic #212 R3).
 *
 * A membership binds a signed-in email to a ROLE and, for a customer, to one
 * tenant. It is the ONLY source of tenant scope: the session cookie carries an
 * email and nothing else, so a role or tenant change (including revocation)
 * takes effect on the next request.
 *
 * Operator-managed: customers never self-provision, and never edit their scope.
 */

import { validateTenantId } from "./tenant";

export type MembershipRole = "operator" | "customer";
export type MembershipStatus = "active" | "suspended";

export interface Membership {
  /** Normalised (lower-cased, trimmed) account email — the session identity. */
  email: string;
  role: MembershipRole;
  /** Required for a `customer`; absent for an `operator` (who sees every tenant). */
  tenantId?: string;
  status: MembershipStatus;
  /** ISO-8601 UTC. */
  createdAt: string;
  /** ISO-8601 UTC. */
  updatedAt: string;
}

export interface MembershipInput {
  email: string;
  role: MembershipRole;
  tenantId?: string;
  status?: MembershipStatus;
}

export class InvalidMembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMembershipError";
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES: MembershipRole[] = ["operator", "customer"];
const STATUSES: MembershipStatus[] = ["active", "suspended"];

/** Lower-case and trim an email, the single canonical form used as the key. */
export function normalizeEmail(email: string): string {
  if (typeof email !== "string") {
    throw new InvalidMembershipError("email must be a string");
  }
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) {
    throw new InvalidMembershipError(
      `email must be a valid address (received ${JSON.stringify(email)})`,
    );
  }
  return trimmed;
}

/** Validate an input into a canonical membership, or throw. */
export function validateMembership(input: MembershipInput): Membership {
  const email = normalizeEmail(input.email);

  if (!ROLES.includes(input.role)) {
    throw new InvalidMembershipError(
      `role must be one of ${ROLES.join(", ")} (received ${JSON.stringify(input.role)})`,
    );
  }
  const status = input.status ?? "active";
  if (!STATUSES.includes(status)) {
    throw new InvalidMembershipError(
      `status must be one of ${STATUSES.join(", ")} (received ${JSON.stringify(status)})`,
    );
  }

  // A customer is scoped to exactly one tenant; an operator is deliberately
  // unscoped. Both directions are rejected loudly rather than silently ignored.
  let tenantId: string | undefined;
  if (input.role === "customer") {
    if (input.tenantId === undefined) {
      throw new InvalidMembershipError("a customer membership requires a tenantId");
    }
    try {
      tenantId = validateTenantId(input.tenantId);
    } catch {
      throw new InvalidMembershipError(
        `tenantId must be an opaque UUID (received ${JSON.stringify(input.tenantId)})`,
      );
    }
  } else if (input.tenantId !== undefined) {
    throw new InvalidMembershipError(
      "an operator membership must not carry a tenantId",
    );
  }

  const now = new Date().toISOString();
  return {
    email,
    role: input.role,
    ...(tenantId !== undefined ? { tenantId } : {}),
    status,
    createdAt: now,
    updatedAt: now,
  };
}

/** Fail-closed: only an explicitly `active` membership may act. */
export function isMembershipActive(
  membership: Pick<Membership, "status">,
): boolean {
  return membership.status === "active";
}

/**
 * The scope a membership grants. An operator is unscoped (sees every tenant);
 * a customer is scoped to exactly one tenant.
 */
export function membershipScope(membership: Membership): {
  role: MembershipRole;
  tenantId?: string;
} {
  if (membership.role === "operator") return { role: "operator" };
  return { role: "customer", tenantId: membership.tenantId as string };
}