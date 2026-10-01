/**
 * Operator-run seeding of the customer tenant registry (#213, epic #212 R1).
 *
 * Run ONCE per environment, BEFORE the repository-to-tenant requirement is
 * enforced (R2). It creates the internal operator tenant and assigns the
 * operator's own repositories to it, so existing operator work keeps a home
 * instead of silently becoming "unassigned" overnight.
 *
 * EXPLICIT by construction: every repository is named on the command line.
 * There is no discovery, no globbing, and no implicit default tenant — guessing
 * here would silently attribute one customer's work to another.
 *
 * IDEMPOTENT: `upsertTenant` is keyed by slug and reuses the existing id, and
 * assignments are keyed by repository slug. Re-running is a no-op that reports
 * what it found.
 *
 * SAFE against re-attribution: it refuses to move a repository that already
 * belongs to a DIFFERENT tenant. Reassigning a customer's repository is a
 * deliberate act, not a side effect of re-running a seed.
 *
 * Usage:
 *   npx tsx scripts/seed-tenant-assignments.ts \
 *     --slug=internal --name="Internal Operations" \
 *     --repo=owner/repo [--repo=owner/other] [--dry-run]
 */

import {
  normalizeRepoSlug,
  validateTenantSlug,
} from "../agent/lib/dark-factory/tenant";
import { validateTenantName } from "../agent/lib/dark-factory/tenant-store";
import type { TenantStore } from "../agent/lib/dark-factory/tenant-store";
import { createTenantStore } from "../agent/lib/dark-factory/tenant-store-provider";

export const USAGE = `Usage: tsx scripts/seed-tenant-assignments.ts \\
  --slug=<tenant-slug> --name="<Tenant Name>" \\
  --repo=<owner/repo> [--repo=<owner/repo> ...] [--dry-run]`;

export interface SeedInput {
  slug: string;
  name: string;
  repos: string[];
  dryRun?: boolean;
}

export interface SeedReport {
  /** The existing tenant id on a re-run; a placeholder when dry-running a create. */
  tenantId: string;
  slug: string;
  name: string;
  /** True when this run created the tenant; false when it already existed. */
  created: boolean;
  /** Repository slugs this run newly assigned. */
  assigned: string[];
  /** Repository slugs that already belonged to this tenant. */
  alreadyAssigned: string[];
  dryRun: boolean;
}

export type SeedResult =
  | { ok: true; report: SeedReport }
  | { ok: false; error: string };

/** Parse `--key=value` arguments. Returns `{ error }` rather than throwing. */
export function parseSeedArgs(argv: string[]): SeedInput | { error: string } {
  let slug: string | undefined;
  let name: string | undefined;
  const repos: string[] = [];
  let dryRun = false;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) {
      return { error: `Unrecognised argument '${arg}'. Expected --key=value.` };
    }
    const key = match[1] ?? "";
    const value = match[2] ?? "";
    if (key === "slug") slug = value;
    else if (key === "name") name = value;
    else if (key === "repo") repos.push(value);
    else return { error: `Unknown option '--${key}'.` };
  }

  if (!slug) return { error: "--slug is required." };
  if (!name) return { error: "--name is required." };
  if (repos.length === 0) {
    return {
      error:
        "At least one --repo is required. There is no implicit default tenant.",
    };
  }
  return { slug, name, repos, dryRun };
}

/**
 * Create-or-update the tenant and assert its repository assignments.
 *
 * Returns `{ ok: false }` for every refusal — a bad slug, an unavailable
 * registry, or an attempted re-attribution — so the CLI can report the reason
 * and exit non-zero rather than half-applying a seed.
 */
export async function seedTenantAssignments(
  store: TenantStore,
  input: SeedInput,
): Promise<SeedResult> {
  let slug: string;
  let name: string;
  let repos: string[];
  try {
    slug = validateTenantSlug(input.slug);
    name = validateTenantName(input.name);
    repos = [...new Set(input.repos.map((repo) => normalizeRepoSlug(repo)))];
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (repos.length === 0) {
    return {
      ok: false,
      error: "At least one repository is required; there is no implicit default.",
    };
  }

  const tenants = await store.listTenants();
  if (!tenants.ok) return { ok: false, error: tenants.error };
  const existing = tenants.value.find((tenant) => tenant.slug === slug);

  const assignments = await store.listRepoAssignments();
  if (!assignments.ok) return { ok: false, error: assignments.error };
  const currentOwner = new Map(
    assignments.value.map((item) => [item.repoSlug, item.tenantId]),
  );

  const conflicts = repos.filter((repo) => {
    const owner = currentOwner.get(repo);
    return owner !== undefined && owner !== existing?.id;
  });
  if (conflicts.length > 0) {
    return {
      ok: false,
      error:
        `Refusing to reassign ${conflicts.join(", ")}: already assigned to ` +
        "another tenant. Moving a repository between customers must be an " +
        "explicit, separate operation.",
    };
  }

  const alreadyAssigned = repos.filter((repo) => currentOwner.has(repo));
  const toAssign = repos.filter((repo) => !currentOwner.has(repo));

  if (input.dryRun) {
    return {
      ok: true,
      report: {
        tenantId: existing?.id ?? "(would be created)",
        slug,
        name,
        created: existing === undefined,
        assigned: toAssign,
        alreadyAssigned,
        dryRun: true,
      },
    };
  }

  let tenantId: string;
  let tenantSlug: string;
  let tenantName: string;
  try {
    const upserted = await store.upsertTenant({ slug, name });
    if (!upserted.ok) return { ok: false, error: upserted.error };
    tenantId = upserted.value.id;
    tenantSlug = upserted.value.slug;
    tenantName = upserted.value.name;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const assigned: string[] = [];
  for (const repo of toAssign) {
    const result = await store.assignRepo(repo, tenantId);
    if (!result.ok) return { ok: false, error: result.error };
    assigned.push(result.value.repoSlug);
  }

  return {
    ok: true,
    report: {
      tenantId,
      slug: tenantSlug,
      name: tenantName,
      created: existing === undefined,
      assigned,
      alreadyAssigned,
      dryRun: false,
    },
  };
}

async function main(): Promise<number> {
  const parsed = parseSeedArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`seed-tenant-assignments: ${parsed.error}`);
    console.error(USAGE);
    return 1;
  }

  const store = createTenantStore();
  try {
    const result = await seedTenantAssignments(store, parsed);
    if (!result.ok) {
      console.error(`seed-tenant-assignments: ${result.error}`);
      return 1;
    }
    const report = result.report;
    console.log(
      `${report.dryRun ? "[dry run] " : ""}tenant '${report.slug}' (${report.tenantId}) — ` +
        `${report.created ? "created" : "already existed"}`,
    );
    if (report.assigned.length > 0) {
      console.log(`  assigned: ${report.assigned.join(", ")}`);
    }
    if (report.alreadyAssigned.length > 0) {
      console.log(`  already assigned: ${report.alreadyAssigned.join(", ")}`);
    }
    return 0;
  } finally {
    await store.close?.();
  }
}

// Only run when executed directly; importing this module (as the tests do) must
// not touch the registry.
const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
if (entry.endsWith("scripts/seed-tenant-assignments.ts")) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}