/**
 * #559 — the runner's wiring for an unmeasured iteration.
 *
 * `scripts/dark-factory-runner.ts` is an out-of-band script: nothing in package.json or CI invokes
 * it, so no behavioural test can reach its worker. Its WIRING is therefore pinned at source level:
 * the unmeasured return path must go through the recorder and the reporter, not only the console.
 *
 * The control case exists so the guard proves it is looking in the right place: if the unmeasured
 * anchor disappeared, every substantive assertion would pass against a file that no longer returns
 * `unmeasured` at all.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RUNNER = readFileSync(
  resolve(process.cwd(), "scripts/dark-factory-runner.ts"),
  "utf8",
);

describe("the runner records an unmeasured iteration (#559)", () => {
  it("resolves the Developer's recorder", () => {
    expect(RUNNER).toContain("resolveAgentOutputRecorder");
  });

  it("CONTROL: still returns unmeasured where the guard is looking", () => {
    expect(RUNNER).toContain("unmeasured: true");
    expect(RUNNER).toContain("COULD NOT RUN");
  });

  it("routes the unmeasured result through the recorder into a reported roadblock", () => {
    // Substance, not an exact string: around the unmeasured return, the path must prepare a
    // roadblock and report it. A bare console line is what it does today, and is not enough.
    const idx = RUNNER.indexOf("unmeasured: true");
    expect(idx).toBeGreaterThan(-1);
    const region = RUNNER.slice(Math.max(0, idx - 2500), idx + 2500);

    expect(region).toMatch(/prepare\(/);
    expect(region).toMatch(/roadblock/);
    expect(region).toMatch(/report\(/);
  });
});
