/**
 * #743: give every finding a root cause and an owner.
 *
 * A blocked run says *that* something failed, and "FAIL" reads as the code being broken. On one day four failures
 * presented exactly that way and only ONE was the agent's code - a sandbox reaped mid-suite, an image without
 * browsers, and a linter run from the wrong directory. Three of them sent a human to fix working code.
 *
 * This generalizes #731, which made the same distinction for one case (an environment fault must not read as broken
 * code) in `developer-agent.ts`. That function and its tests are untouched: its code/environment distinction is a
 * subset of the vocabulary here, and rewriting it would have meant revising tests that pin a correct behaviour.
 *
 * Vendor output enters through `PATTERNS` - that matching IS the adapter. The vocabulary names causes, never tools,
 * repositories or frameworks, so a new tool's wording is a new pattern rather than a new cause.
 */

export type FindingCause = "code" | "spec" | "harness" | "image" | "environment" | "ci" | "unknown";

/** Who can act. Derived from the cause, never chosen separately - see the table below. */
export type FindingOwner = "agent" | "factory" | "operator" | "nobody-yet";

export interface FindingClassification {
  cause: FindingCause;
  owner: FindingOwner;
  /**
   * The output that decided the classification, quoted.
   *
   * Not decoration: without it a wrong classification cannot be re-examined, and re-examination is the only reason
   * the four rows above were ever told apart. An unknown finding carries an empty string - evidence invented for an
   * unrecognized failure would read as a diagnosis.
   */
  evidence: string;
}

/** The owner follows from the cause. A single table, so the two cannot drift apart. */
const OWNERS: Record<FindingCause, FindingOwner> = {
  code: "agent",
  spec: "agent",
  harness: "factory",
  ci: "factory",
  image: "operator",
  environment: "operator",
  unknown: "nobody-yet",
};

/**
 * Ordered MOST SPECIFIC FIRST, with `code` last.
 *
 * The order is part of the fail-closed property rather than an accident of writing: `code` is the cause that sends a
 * human to fix something, so it is only reached when nothing more specific matched. A generic pattern listed above a
 * specific one would re-create, in miniature, the bug this module exists to fix.
 */
const PATTERNS: ReadonlyArray<{ cause: FindingCause; pattern: RegExp }> = [
  // The image is missing a tool the suite needs. Distinct from `environment`: nothing timed out or vanished.
  { cause: "image", pattern: /executable (does not|doesn't) exist|browserType\.launch|not found: (chromium|chrome|firefox)/i },
  // The sandbox or its runtime went away, or was never reachable.
  { cause: "environment", pattern: /container not found|unable to upgrade connection|ECONNREFUSED|connection refused|no space left on device/i },
  // The harness ran the tool somewhere it could not work from.
  // Alternatives are written out in full rather than as an optional-group regex: the spell checker splits that form
  // and reports a piece of it as an unknown word, which is not something to teach a dictionary.
  { cause: "harness", pattern: /no eslint configuration found|could not find (an )?(eslint )?config|configuration file not found|config file not found|unknown option .* from the harness/i },
  // The pipeline itself refused: credentials, permissions, a missing runner capability.
  { cause: "ci", pattern: /resource not accessible by integration|bad credentials|permission denied.*(workflow|workflows)|refusing to allow .* to (create|update)/i },
  // The story or the test is ambiguous rather than the code being wrong.
  { cause: "spec", pattern: /strict mode violation|resolved to \d+ elements|ambiguous|multiple elements/i },
  // The code, last: an assertion that genuinely failed.
  { cause: "code", pattern: /assertionerror|expected .* to (equal|be|contain|have)|test(s)? failed|failed:\s/i },
];

/**
 * Classify a finding from its own output.
 *
 * Fail-closed: anything unrecognized is `unknown`, **never** `code`. Defaulting to `code` is #731's error in the
 * opposite direction - it tells a human to go and fix something that is not broken - and it is the failure mode that
 * would make this worse than no classification at all.
 */
export function classifyFinding(output: string): FindingClassification {
  const text = typeof output === "string" ? output : "";

  for (const { cause, pattern } of PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { cause, owner: OWNERS[cause], evidence: match[0] };
    }
  }

  return { cause: "unknown", owner: "nobody-yet", evidence: "" };
}
