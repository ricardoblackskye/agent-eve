import { type NextRequest, NextResponse } from "next/server";
import { createTenantStore } from "../../../../agent/lib/dark-factory/tenant-store-provider";
import { getViewerSession } from "../viewer-auth";
import { okJson, serviceUnavailable, unauthorized } from "../responses";

/**
 * Operator-only, read-only view of the customer tenant registry (#213, epic #212 R1).
 *
 * Lists the tenants and the repository assignments that drive run attribution.
 * This is the surface an operator uses to answer "which customer is this
 * repository billed to, and has it been assigned at all?" — so a repository
 * that has NOT been assigned is visibly absent from the list rather than
 * silently defaulted to somebody.
 *
 * Counts and identifiers only: no issue text, no prompt or completion content.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const viewer = await getViewerSession(request);
  if (!viewer) return unauthorized();

  let store;
  try {
    store = createTenantStore();
  } catch {
    // Fail-closed on a misconfigured registry (e.g. an unknown driver) rather
    // than serving an empty list that looks like "no customers exist".
    return serviceUnavailable("Customer tenants are unavailable");
  }

  try {
    const tenants = await store.listTenants();
    if (!tenants.ok) return serviceUnavailable("Customer tenants are unavailable");
    const assignments = await store.listRepoAssignments();
    if (!assignments.ok) return serviceUnavailable("Customer tenants are unavailable");
    return okJson({
      tenants: tenants.value,
      assignments: assignments.value,
    });
  } finally {
    await store.close?.();
  }
}