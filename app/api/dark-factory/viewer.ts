/**
 * Dark Factory — per-request viewer resolution (#215, epic #212 R3).
 *
 * Turns a verified session into an IDENTITY + SCOPE, or a refusal. The session
 * cookie carries only an email, so the role and tenant are read from the
 * membership store on EVERY request: a revocation, a suspension, or a scope
 * change takes effect on the next request rather than waiting out a stale claim.
 *
 * Fail-closed at every step — no session, no membership, an unreadable store and
 * a suspended account all refuse.
 */

import {
  isMembershipActive,
  membershipScope,
  type MembershipRole,
} from "../../../agent/lib/dark-factory/membership";
import {
  createMembershipStore,
  type MembershipStore,
} from "../../../agent/lib/dark-factory/membership-store";
import { getViewerSession } from "./viewer-auth";

/** The resolved identity and scope for one request. */
export interface Viewer {
  email: string;
  role: MembershipRole;
  /** Present for a customer; absent for an operator (unscoped). */
  tenantId?: string;
}

export type ViewerResolution =
  | { ok: true; viewer: Viewer }
  | { ok: false; status: 401 | 403; error: string };

export async function resolveViewer(
  request: Request,
  deps: { store?: MembershipStore } = {},
): Promise<ViewerResolution> {
  const session = await getViewerSession(request);
  if (!session) {
    return { ok: false, status: 401, error: "Not authenticated." };
  }

  let store = deps.store;
  let owned = false;
  if (!store) {
    try {
      store = createMembershipStore();
      owned = true;
    } catch {
      return { ok: false, status: 403, error: "Membership store is unavailable." };
    }
  }

  try {
    const read = await store.getMembership(session.email);
    if (!read.ok) {
      return { ok: false, status: 403, error: "Membership store is unavailable." };
    }
    if (!read.value) {
      return { ok: false, status: 403, error: "No membership for this account." };
    }
    if (!isMembershipActive(read.value)) {
      return { ok: false, status: 403, error: "This account is suspended." };
    }
    const scope = membershipScope(read.value);
    return { ok: true, viewer: { email: read.value.email, ...scope } };
  } finally {
    // Only close a store this call created; an injected one is the caller's.
    if (owned) await store.close?.();
  }
}