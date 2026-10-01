/**
 * Resolve the tenant a newly accepted run is attributed to (#213, epic #212 R1).
 *
 * Resolution is TOTAL, and that is the point: an unconfigured registry, an
 * unassigned repository, a registry outage, or a store that throws all degrade
 * to UNASSIGNED (undefined) rather than failing. R1 only RECORDS attribution —
 * refusing to accept a run because it cannot be attributed would break existing
 * operator flows before the repository seed has been applied everywhere. The
 * refusal half of the contract belongs to R2, and is enforced there.
 *
 * An INACTIVE tenant still attributes. The run genuinely belongs to them, and
 * historical attribution must not be rewritten when they are re-activated.
 */
import type { TenantStore } from "./tenant-store";

export async function resolveRunTenant(
  store: TenantStore | undefined,
  repo: string,
): Promise<string | undefined> {
  if (!store) return undefined;
  try {
    const result = await store.resolveTenantForRepo(repo);
    if (!result.ok) return undefined;
    return result.value.tenant?.id;
  } catch {
    // A resolution failure must never block acceptance. Recording the run as
    // unassigned is recoverable; losing the run is not.
    return undefined;
  }
}