/**
 * Operator CLI for the self-improvement gate (#159).
 *
 * The gate in `self-improve.ts` blocks every `access-widening` proposal until a
 * decision is recorded ("blocked: operator gate missing"), and NOTHING in the
 * application records one: `createOperatorDecisionStore` is re-exported but
 * never called outside its test. This module is therefore the only way the gate
 * can be satisfied, which is why every rule below is fail-closed.
 *
 * Deliberately PURE: it takes an injected decision store and clock and returns
 * `{ lines, exitCode }`. No `process`, no `console`, no filesystem — so the
 * behaviour is provable in tests and identical wherever it is invoked.
 */

import type {
  OperatorDecision,
  OperatorDecisionStore,
} from "./self-improve-state";

export type ProposalKind = "bounded-tuning" | "access-widening";
export type OperatorDecisionValue = "allow" | "deny";

/** A usage mistake (bad command/flag): exit 2, and nothing is written. */
export class OperatorCliUsageError extends Error {}

export const OPERATOR_CLI_USAGE: string[] = [
  "Usage: operator <command> [args]",
  "  list                                        show armed decisions",
  "  allow <surfaceId> [--kind K] [--by NAME] [--expires T]",
  "  deny  <surfaceId> [--kind K] [--by NAME] [--expires T]",
  "  clear <surfaceId> [--kind K]                revoke the decision",
  "  --kind    bounded-tuning | access-widening (default access-widening)",
  "  --expires ISO-8601 with offset (2030-01-02T03:04:05Z), +7d/+12h/+30m, or 'never'",
];

export type OperatorCliCommand =
  | { kind: "list" }
  | { kind: "clear"; surfaceId: string; proposalKind: ProposalKind }
  | {
      kind: "set";
      decision: OperatorDecisionValue;
      surfaceId: string;
      proposalKind: ProposalKind;
      by: string | null;
      /**
       * UNRESOLVED expiry expression, or null when the operator omitted it or
       * said 'never'. Resolution happens in `runOperatorCli` so that a malformed
       * value is a REFUSAL (exit 1) rather than a usage error.
       */
      expiresAt: string | null;
    };

export interface OperatorCliDeps {
  /** id of the state store holding the decisions — echoed so the operator sees WHERE. */
  storeId: string;
  /** resolved store target (e.g. the SQLite path), or null when not file-backed. */
  target: string | null;
  decisions: OperatorDecisionStore;
  now?: () => Date;
}

export interface OperatorCliResult {
  lines: string[];
  exitCode: number;
}

/**
 * The proposal kinds this CLI can set, derived from a `Record` so the CLI's
 * vocabulary CANNOT drift from the controller's: adding a member to
 * `ProposalKind` without listing it here is a compile error rather than a
 * silently missing option. (The runtime list must exist for argv parsing, so it
 * is derived FROM the exhaustive map rather than written beside it.)
 */
const KIND_HELP: Record<ProposalKind, string> = {
  "access-widening": "grants capability; requires the operator gate",
  "bounded-tuning": "numerical bounds only; the controller may apply it itself",
};
const KINDS = Object.keys(KIND_HELP) as ProposalKind[];
const DEFAULT_KIND: ProposalKind = "access-widening";

const COMMANDS = ["list", "allow", "deny", "clear"] as const;
type CommandName = (typeof COMMANDS)[number];

/**
 * Charset for a surface id.
 *
 * A surface id is an opaque key that is both PERSISTED and PRINTED, so a value
 * carrying control characters or format metacharacters could forge a stored
 * record or a log line. This set accepts every id this repo's surfaces use
 * (`iteration-bounds`, `skill-set`) while refusing whitespace, NUL and newlines.
 */
const SURFACE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * `--by` is a human name, so it accepts anything printable (spaces, apostrophes,
 * hyphens) but NOT control characters: the name is persisted and printed, and a
 * newline or NUL could forge a record or a log line.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

/** Parse argv into a command, or throw `OperatorCliUsageError` naming the problem. */
export function parseOperatorArgs(argv: string[]): OperatorCliCommand {
  const command = argv[0];
  if (!command) throw new OperatorCliUsageError("Missing command.");
  if (!isCommandName(command)) {
    throw new OperatorCliUsageError(
      `Unknown command '${command}'. Expected one of: ${COMMANDS.join(", ")}.`,
    );
  }

  let surfaceId: string | null = null;
  let proposalKind: ProposalKind = DEFAULT_KIND;
  let by: string | null = null;
  let expiresAt: string | null = null;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new OperatorCliUsageError(`Option '${arg}' needs a value.`);
      }
      i += 1;
      if (arg === "--kind") {
        if (!KINDS.includes(value as ProposalKind)) {
          throw new OperatorCliUsageError(
            `Unknown --kind '${value}'. Expected ${KINDS.join(" or ")}.`,
          );
        }
        proposalKind = value as ProposalKind;
      } else if (arg === "--by") {
        if (value.trim() === "" || CONTROL_CHARS.test(value)) {
          throw new OperatorCliUsageError(
            `Invalid --by ${JSON.stringify(value)}: use a printable name, without control characters.`,
          );
        }
        by = value;
      } else if (arg === "--expires") {
        // 'never' is an EXPLICIT null; anything else stays unresolved so a typo
        // is refused later rather than silently meaning "never expires".
        expiresAt = value === "never" ? null : value;
      } else {
        throw new OperatorCliUsageError(`Unknown option '${arg}'.`);
      }
      continue;
    }
    if (surfaceId !== null) {
      throw new OperatorCliUsageError(`Unexpected extra argument '${arg}'.`);
    }
    if (!SURFACE_ID_PATTERN.test(arg)) {
      throw new OperatorCliUsageError(
        `Invalid surfaceId ${JSON.stringify(arg)}: use letters, digits and . _ : - only.`,
      );
    }
    surfaceId = arg;
  }

  if (command === "list") {
    if (surfaceId !== null) {
      throw new OperatorCliUsageError("'list' takes no arguments.");
    }
    return { kind: "list" };
  }
  if (surfaceId === null) {
    throw new OperatorCliUsageError(`Missing <surfaceId> for '${command}'.`);
  }
  if (command === "clear") return { kind: "clear", surfaceId, proposalKind };
  return {
    kind: "set",
    decision: command,
    surfaceId,
    proposalKind,
    by,
    expiresAt,
  };
}

/**
 * Resolve an expiry expression to ISO-8601, or null for "until superseded".
 *
 * A malformed value THROWS: writing null on a typo would silently grant an
 * unbounded permission, which is the opposite of what the operator asked for.
 * An ISO timestamp MUST carry an offset, so an ambiguous local time is refused.
 */
function resolveExpiry(raw: string | null, now: () => Date): string | null {
  if (raw === null) return null;

  const relative = /^\+(\d+)([dhm])$/.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const ms = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
    // A relative amount can exceed the representable date range (or parse to
    // Infinity), which made `toISOString()` throw a RangeError straight out of
    // the command layer. Refuse it as a refusal, like any other bad expiry.
    const when = new Date(now().getTime() + amount * ms);
    if (Number.isNaN(when.getTime())) {
      throw new OperatorCliUsageError(
        `--expires '${raw.slice(0, 24)}' overflows the supported date range. ` +
          "Refusing to arm: nothing was recorded.",
      );
    }
    return when.toISOString();
  }

  const isoTimestamp =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  if (isoTimestamp.test(raw)) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }

  throw new OperatorCliUsageError(
    `Unparseable --expires '${raw}'. Use an ISO-8601 timestamp WITH an offset ` +
      "(2030-01-02T03:04:05Z), a relative +7d/+12h/+30m, or 'never'. " +
      "Refusing to arm: a typo must not mean 'never expires'.",
  );
}

function isExpired(decision: OperatorDecision, now: Date): boolean {
  if (decision.expiresAt === null) return false;
  const expiry = Date.parse(decision.expiresAt);
  // An expiry that cannot be read counts as EXPIRED, never as still valid — the
  // same stance `operatorGateFromStore` takes, so a corrupt timestamp cannot
  // silently extend an approval.
  if (Number.isNaN(expiry)) return true;
  return now.getTime() >= expiry;
}

/** Run a command against the injected store. Never throws for an expected refusal. */
export async function runOperatorCli(
  argv: string[],
  deps: OperatorCliDeps,
): Promise<OperatorCliResult> {
  let command: OperatorCliCommand;
  try {
    command = parseOperatorArgs(argv);
  } catch (error) {
    if (error instanceof OperatorCliUsageError) {
      return { lines: [error.message, ...OPERATOR_CLI_USAGE], exitCode: 2 };
    }
    throw error;
  }

  const now = deps.now ?? (() => new Date());
  const where = `store '${deps.storeId}'${deps.target ? ` @ ${deps.target}` : ""}`;

  if (command.kind === "list") {
    const all = await deps.decisions.list();
    if (all.length === 0) {
      return {
        lines: [`No operator decisions are armed in ${where}.`],
        exitCode: 0,
      };
    }
    const at = now();
    const lines = all.map((decision) => {
      const state = isExpired(decision, at) ? "  [expired]" : "";
      return (
        `  ${decision.surfaceId}  ${decision.kind}  ${decision.decision}` +
        `  by ${decision.decidedBy}  (expires ${decision.expiresAt ?? "never"})${state}`
      );
    });
    return { lines: [`Decisions in ${where}:`, ...lines], exitCode: 0 };
  }

  if (command.kind === "clear") {
    await deps.decisions.clear(command.surfaceId, command.proposalKind);
    return {
      lines: [
        `Revoked the ${command.proposalKind} decision for '${command.surfaceId}' in ${where}.`,
      ],
      exitCode: 0,
    };
  }

  // Arming a widening is the one decision with real consequences, so it must
  // carry a name: `decidedBy` is documented as audit-only and unauthenticated,
  // and the CLI will not invent an author for it.
  if (
    command.decision === "allow" &&
    command.proposalKind === "access-widening"
  ) {
    if (!command.by) {
      return {
        lines: [
          "Refusing to arm an access-widening 'allow' without --by NAME: the record " +
            "is the audit trail for granting capability. Nothing was recorded.",
        ],
        exitCode: 1,
      };
    }
  }

  let expiresAt: string | null;
  try {
    expiresAt = resolveExpiry(command.expiresAt, now);
  } catch (error) {
    if (error instanceof OperatorCliUsageError) {
      return { lines: [error.message], exitCode: 1 };
    }
    throw error;
  }

  // An expiry that is not in the future makes the grant inert the instant it is
  // recorded: it would look like a successful grant while silently refusing.
  // A past (or zero) time is therefore REFUSED, and `deny` is the explicit way
  // to refuse — the same reasoning as refusing a malformed expiry.
  if (expiresAt !== null && Date.parse(expiresAt) <= now().getTime()) {
    return {
      lines: [
        `Refusing to arm: --expires '${command.expiresAt}' is not in the future, so the ` +
          "decision would already be expired. Use 'deny' to refuse it explicitly, or " +
          "'never' for no expiry. Nothing was recorded.",
      ],
      exitCode: 1,
    };
  }

  const decision: OperatorDecision = {
    surfaceId: command.surfaceId,
    kind: command.proposalKind,
    decision: command.decision,
    decidedBy: command.by ?? "unspecified",
    decidedAt: now().toISOString(),
    expiresAt,
  };

  try {
    await deps.decisions.record(decision);
  } catch (error) {
    // The store refused to persist (an unset driver yields the fail-closed
    // console provider, which refuses every write). Reporting success here would
    // tell the operator that capability was granted when nothing was recorded.
    return {
      lines: [
        `Could not persist the decision in ${where}: ${(error as Error).message}`,
        "Nothing was recorded. Set DF_STATE_DRIVER (and DF_STATE_DB_PATH for sqlite) " +
          "so the store the app reads is the one this CLI writes.",
      ],
      exitCode: 1,
    };
  }

  const lines = [
    `${decision.decision} recorded for '${decision.surfaceId}' ` +
      `(${decision.kind}) by ${decision.decidedBy}, ` +
      `expires ${decision.expiresAt ?? "never"}.`,
  ];
  lines.push(`Armed in ${where}.`);
  if (decision.kind === "access-widening" && decision.decision === "allow") {
    lines.push(
      "The controller will now see a satisfied operator gate for this surface.",
    );
  }
  return { lines, exitCode: 0 };
}
