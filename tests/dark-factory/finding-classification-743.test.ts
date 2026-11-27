import { describe, expect, it } from "vitest";
import { classifyFinding } from "../../agent/lib/dark-factory/finding-classification";

/**
 * #743 - every finding gets a root cause and an owner, so a blocked run is a decision rather than a log.
 *
 * The cases below are the issue's own table: four failures that all presented as "FAIL" and only ONE of which was the
 * agent's code. Each was misread at least once before the evidence settled it, which is the cost this classifier pays
 * down.
 *
 * Load-bearing properties, asserted rather than implied:
 * - **fail-closed**: an unrecognized finding is `unknown`, NEVER `code`. Defaulting to `code` is #731's error in the
 *   opposite direction - it sends a human to fix working code - and it is the failure mode that makes the whole
 *   feature worse than nothing.
 * - **the evidence travels with the classification**: a cause with no quoted output cannot be re-examined when it is
 *   wrong, and re-examination is how the original four rows were ever told apart.
 */
const MISSING_BROWSER = "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium/chrome";
const SANDBOX_REAPED = "error: unable to upgrade connection: container not found (\"df-sandbox-webfeedpoc\")";
const ASSERTION = "AssertionError: expected 'Built by' to equal 'Built by the Dark Factory'";
const LINT_WRONG_DIR = "ESLint: No ESLint configuration found in /workspace/__mocks__";
const LOCATOR_STRICT = "Error: strict mode violation: locator('footer') resolved to 2 elements";
const CI_PERMISSION = "Error: Resource not accessible by integration";
const UNKNOWN_SHAPE = "exited with status 17 while doing something nobody has seen before";

describe("#743 - each real failure gets its cause", () => {
  it("a missing browser is the IMAGE, not broken code", () => {
    const r = classifyFinding(MISSING_BROWSER);
    expect(r.cause).toBe("image");
    expect(r.owner).toBe("operator");
  });

  it("a sandbox that vanished mid-suite is the ENVIRONMENT, not broken code", () => {
    const r = classifyFinding(SANDBOX_REAPED);
    expect(r.cause).toBe("environment");
    expect(r.owner).toBe("operator");
  });

  it("an assertion failure IS broken code, owned by the agent", () => {
    // The one row FAIL was always right about. Asserted so the change cannot swallow it.
    const r = classifyFinding(ASSERTION);
    expect(r.cause).toBe("code");
    expect(r.owner).toBe("agent");
  });

  it("a linter run from the wrong directory is the HARNESS, owned by the factory", () => {
    // The row that most misled a reader: it looked exactly like broken code.
    const r = classifyFinding(LINT_WRONG_DIR);
    expect(r.cause).toBe("harness");
    expect(r.owner).toBe("factory");
  });

  it("an ambiguous locator is the SPEC, which the agent can resolve", () => {
    const r = classifyFinding(LOCATOR_STRICT);
    expect(r.cause).toBe("spec");
    expect(r.owner).toBe("agent");
  });

  it("a permission failure in CI is CI, owned by the factory", () => {
    const r = classifyFinding(CI_PERMISSION);
    expect(r.cause).toBe("ci");
    expect(r.owner).toBe("factory");
  });
});

describe("#743 - fail-closed, the control that matters", () => {
  it("an unrecognized finding is UNKNOWN, and explicitly not code", () => {
    const r = classifyFinding(UNKNOWN_SHAPE);

    expect(r.cause).toBe("unknown");
    expect(r.owner).toBe("nobody-yet");
    // Stated twice on purpose: this is the assertion that stops the feature becoming a `code` default.
    expect(r.cause).not.toBe("code");
  });

  it("empty and whitespace-only output is UNKNOWN, not code", () => {
    expect(classifyFinding("").cause).toBe("unknown");
    expect(classifyFinding("   \n  ").cause).toBe("unknown");
  });
});

describe("#743 - the evidence travels with the cause", () => {
  it("quotes the output that decided the classification", () => {
    const r = classifyFinding(MISSING_BROWSER);
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(MISSING_BROWSER.includes(r.evidence)).toBe(true);
  });

  it("an unknown finding carries no invented evidence", () => {
    // Evidence that was not in the output would be worse than none: it reads as a diagnosis.
    expect(classifyFinding(UNKNOWN_SHAPE).evidence).toBe("");
  });
});

describe("#743 - the owner always follows from the cause", () => {
  it("holds for every classification, so ownership is never chosen separately", () => {
    const owners: Record<string, string> = {
      code: "agent",
      spec: "agent",
      harness: "factory",
      ci: "factory",
      image: "operator",
      environment: "operator",
      unknown: "nobody-yet",
    };

    for (const output of [MISSING_BROWSER, SANDBOX_REAPED, ASSERTION, LINT_WRONG_DIR, LOCATOR_STRICT, CI_PERMISSION, UNKNOWN_SHAPE]) {
      const r = classifyFinding(output);
      expect(owners[r.cause]).toBe(r.owner);
    }
  });
});
