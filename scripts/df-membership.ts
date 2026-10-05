/**
 * Dark Factory — operator CLI for customer membership (#215, epic #212 R3).
 *
 * Membership is OPERATOR-MANAGED: this is the supported way to grant a customer
 * access, to change their scope, and to revoke it. Customers never self-provision.
 *
 *   npm run df:membership -- grant --email customer@acme.test --role customer --tenant <uuid>
 *   npm run df:membership -- grant --email ops@acme.test --role operator
 *   npm run df:membership -- suspend --email customer@acme.test
 *   npm run df:membership -- activate --email customer@acme.test
 *   npm run df:membership -- list
 *
 * The driver comes from the environment (`DF_MEMBERSHIP_DRIVER`), so the same
 * command works against the local SQLite database or the deployed Postgres.
 * Fails closed: an unconfigured driver refuses rather than appearing to succeed.
 */

import { validateMembership, type MembershipRole } from "../agent/lib/dark-factory/membership";
import { createMembershipStore } from "../agent/lib/dark-factory/membership-store";
import { loadLocalEnv } from "./load-env";

const USAGE = `Usage:
  df:membership grant --email <address> --role <operator|customer> [--tenant <uuid>]
  df:membership suspend --email <address>
  df:membership activate --email <address>
  df:membership list`;

export interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    flags[name] = value;
    i += 1;
  }
  return { command, flags };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

async function main(): Promise<void> {
  // The app reads .env.local; a bare tsx run would not, so without this the CLI
  // and the app can disagree about which store — and which database — is in
  // play. Shell-exported values still win.
  loadLocalEnv();

  const { command, flags } = parseArgs(process.argv.slice(2));
  const store = createMembershipStore();

  try {
    switch (command) {
      case "grant": {
        const email = requireFlag(flags, "email");
        const role = requireFlag(flags, "role") as MembershipRole;
        // Validate BEFORE writing, so a bad scope never reaches the store.
        const candidate = validateMembership({
          email,
          role,
          ...(flags.tenant ? { tenantId: flags.tenant } : {}),
        });
        const written = await store.upsertMembership({
          email: candidate.email,
          role: candidate.role,
          ...(candidate.tenantId ? { tenantId: candidate.tenantId } : {}),
        });
        if (!written.ok) throw new Error(written.error);
        console.log(
          `granted ${written.value.email} role=${written.value.role}` +
            `${written.value.tenantId ? ` tenant=${written.value.tenantId}` : ""} status=${written.value.status}`,
        );
        break;
      }
      case "suspend":
      case "activate": {
        const email = requireFlag(flags, "email");
        const status = command === "suspend" ? "suspended" : "active";
        const written = await store.setMembershipStatus(email, status);
        if (!written.ok) throw new Error(written.error);
        const label = command === "suspend" ? "suspended" : "activated";
        console.log(`${label} ${written.value.email} status=${written.value.status}`);
        break;
      }
      case "list": {
        const listed = await store.listMemberships();
        if (!listed.ok) throw new Error(listed.error);
        if (listed.value.length === 0) {
          console.log("no memberships");
          break;
        }
        for (const member of listed.value) {
          console.log(
            `${member.email} role=${member.role}` +
              `${member.tenantId ? ` tenant=${member.tenantId}` : ""} status=${member.status}`,
          );
        }
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await store.close?.();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});