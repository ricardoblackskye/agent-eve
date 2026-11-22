import { describe, expect, it, vi } from "vitest";
import {
  classifyE2eFailure,
  formatTestVerdict,
  runDeclaredE2e,
} from "../../agent/lib/dark-factory/developer-agent";

/**
 * #731 — a suite that failed because the SANDBOX could not run it must not be read as broken code.
 *
 * The real case, from the run against WebFeedPOC #253 on image `df-sandbox-webfeedpoc:4`: 664 failures,
 * every one identical, all `browserType.launch: Executable doesn't exist` - an image carrying no browsers.
 * The loop spent its entire 60-worker-minute budget correcting code that was correct.
 *
 * The rule is deliberately narrow, and the asymmetry is the reason: a false `failed` costs one iteration,
 * while a false `environment` would let a red suite reach a pull request - the one thing #701 exists to
 * prevent. So this file carries a mutation (the shape that MUST be caught) and controls (the shapes that
 * must NOT be), because a helper that flags everything would pass the mutation and fail the controls.
 */

/** The #253 shape, reproduced verbatim from the run's output. */
const launchBurst = Array.from({ length: 12 }, (_, i) =>
  [
    `  ${i + 1}) [chromium-tablet-pro] › e2e/product-card-responsiveness.spec.ts:26:3 › test ${i}`,
    "    Error: browserType.launch: Executable doesn't exist at",
    "    /home/node/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell",
  ].join("\n"),
).join("\n");

describe("#731 classifying an e2e failure", () => {
  it("MUTATION: the #253 launch burst is an environment fault, not broken code", () => {
    expect(classifyE2eFailure(launchBurst)).toBe("environment");
  });

  it("CONTROL: differing assertion failures are a code fault", () => {
    const mixed = [
      "  1) a.spec.ts › renders the footer",
      "    Error: expected 'Built by the Dark Factory' to be 'Something else'",
      "  2) a.spec.ts › is italic",
      "    Error: expected 'SPAN' to be 'EM'",
    ].join("\n");

    expect(classifyE2eFailure(mixed)).toBe("failed");
  });

  it("CONTROL: identical failures from a broken shared import are a code fault", () => {
    // This is the case that stops 'identical text' being sufficient on its own: one bad import fails
    // every test with byte-identical output, and it is exactly the developer's bug.
    const importBurst = Array.from({ length: 9 }, (_, i) =>
      `  ${i + 1}) suite ${i}\n    Error: Cannot find module './missing' imported from src/a.js`,
    ).join("\n");

    expect(classifyE2eFailure(importBurst)).toBe("failed");
  });

  it("CONTROL: a single launch failure is one test, not a shape", () => {
    const one = launchBurst.split("\n").slice(0, 3).join("\n");
    expect(classifyE2eFailure(one)).toBe("failed");
  });

  it("CONTROL: the local-promotion-site EACCES shape is also an environment fault", () => {
    // The other image failed differently and just as wrongly (#735): root-owned node_modules meant the
    // dev server never started.
    const eaccesBurst = Array.from({ length: 5 }, (_, i) =>
      `  ${i + 1}) spec ${i}\n    Error: EACCES: permission denied, mkdir '/workspace/node_modules/.vite/deps_temp_fe890ab9'`,
    ).join("\n");

    expect(classifyE2eFailure(eaccesBurst)).toBe("environment");
  });

  it("CONTROL: empty output is not an environment fault", () => {
    expect(classifyE2eFailure("")).toBe("failed");
  });
});

describe("#731 the outcome the loop consumes", () => {
  const ALLOWED = ["npm test", "npm run test:e2e"];
  const stubbed = (output: string) =>
    vi.fn().mockResolvedValue({ passed: false, output, ran: true });

  it("maps an image-shaped failure to `environment`, not to `failed`", async () => {
    const outcome = await runDeclaredE2e({
      runTests: stubbed(launchBurst),
      command: "npm run test:e2e",
      allowedCommands: ALLOWED,
    });
    expect(outcome.status).toBe("environment");
    expect(outcome.output).toContain("browserType.launch");
  });

  it("still reports `failed` for a genuine code failure", async () => {
    const outcome = await runDeclaredE2e({
      runTests: stubbed("  1) a.spec.ts\n    Error: expected 'A' to be 'B'"),
      command: "npm run test:e2e",
      allowedCommands: ALLOWED,
    });
    expect(outcome.status).toBe("failed");
  });
});

describe("#731 the verdict names the reason", () => {
  it("says the sandbox could not run the suite, and still says FAIL", () => {
    const verdict = formatTestVerdict(false, { ran: ["unit", "e2e"], notRun: [] }, "environment");
    expect(verdict).toBe("FAIL (unit, e2e: the sandbox could not run it)");
  });

  it("leaves an ordinary code failure's wording unchanged", () => {
    expect(formatTestVerdict(false, { ran: ["unit", "e2e"], notRun: [] })).toBe("FAIL (unit, e2e)");
  });
});
