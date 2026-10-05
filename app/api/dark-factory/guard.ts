import type { NextRequest, NextResponse } from "next/server";
import { forbidden, unauthorized } from "./responses";
import { resolveViewer, type Viewer } from "./viewer";

/**
 * Dark Factory route guard (#215, epic #212 R3).
 *
 * Turns a request into an authenticated viewer, or the exact response to return.
 * Routes must use one of these instead of the raw session check, so that every
 * Dark Factory surface resolves the caller's ROLE and TENANT the same way — from
 * the membership store, on every request, never from the session cookie.
 */

export type Guard =
  { ok: true; viewer: Viewer } | { ok: false; response: NextResponse };

/** Any signed-in account with an active membership. */
export async function guardViewer(request: NextRequest): Promise<Guard> {
  const resolved = await resolveViewer(request);
  if (!resolved.ok) {
    return {
      ok: false,
      response:
        resolved.status === 401 ? unauthorized() : forbidden(resolved.error),
    };
  }
  return { ok: true, viewer: resolved.viewer };
}

/**
 * An operator only. A customer is refused rather than silently served a
 * cross-tenant view: every surface that spans tenants — the tenant registry,
 * the global budget ledger, factory control and the LLM policy — is
 * operator-only in this release.
 */
export async function guardOperator(request: NextRequest): Promise<Guard> {
  const guard = await guardViewer(request);
  if (!guard.ok) return guard;
  if (guard.viewer.role !== "operator") {
    return { ok: false, response: forbidden("Operator access required.") };
  }
  return guard;
}
