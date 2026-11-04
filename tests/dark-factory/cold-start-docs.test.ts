/**
 * #597 (AC3) — the cold-start measurement must be recorded in repo docs, not only in an issue thread.
 *
 * #383 measured cold start against a live local cluster and reported it in a comment. A reader of the
 * repository could not find the figure at all, so the Pillar 5 claim "cold-start under 10 minutes" had
 * no evidence an operator could reach. This guard pins the numbers AND their conditions: a figure
 * quoted without "warm cluster, image already in containerd" would overstate what was measured.
 *
 * Assertions are about CONTENT REQUIRED, not exact prose, so wording edits stay cheap while dropping
 * the measurement fails the build. The section is sliced out of the doc first: a repo-wide substring
 * search would be satisfied by the same digits appearing anywhere else (an ADR, a plan file), leaving
 * the page that regressed unguarded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const DOC = readFileSync(join(ROOT, "docs/pages/dark-factory-local-runs.md"), "utf8");

const DISCONNECT_HEADING = "### What does not survive a disconnect";
const COLD_START_HEADING = "### Cold start for the pre-built image";
const SECRETS_HEADING = "### Secrets at runtime";

/** The cold-start section only: from its heading up to the next `### ` heading. */
function coldStartSection(): string {
  const start = DOC.indexOf(COLD_START_HEADING);
  if (start === -1) return "";
  const rest = DOC.slice(start + COLD_START_HEADING.length);
  const next = rest.search(/^### /m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("#597 — cold-start measurement is recorded in repo docs", () => {
  it("keeps the neighboring sections the new one is placed between (positive control)", () => {
    // Proves the guard is reading the real page and not an empty string. If this fails, the doc was
    // restructured and the section slice below is measuring nothing.
    expect(DOC).toContain(DISCONNECT_HEADING);
    expect(DOC).toContain(SECRETS_HEADING);
  });

  it("has a cold-start section adjacent to the disconnect section", () => {
    const disconnectAt = DOC.indexOf(DISCONNECT_HEADING);
    const coldAt = DOC.indexOf(COLD_START_HEADING);
    const secretsAt = DOC.indexOf(SECRETS_HEADING);
    expect(coldAt, "cold-start section is missing").toBeGreaterThan(-1);
    // "Next to" — after the disconnect section and before the next topic, so an operator reading
    // the run-lifecycle material meets the measurement without hunting.
    expect(coldAt).toBeGreaterThan(disconnectAt);
    expect(coldAt).toBeLessThan(secretsAt);
  });

  it("records the measured figures and their range", () => {
    const section = coldStartSection();
    expect(section.length, "cold-start section is empty").toBeGreaterThan(0);
    // The three runs, the median, and the range — the actual evidence, not a rounded claim.
    expect(section).toContain("2.63");
    expect(section).toContain("2.41");
    expect(section).toContain("3.02");
    expect(section).toMatch(/range/i);
  });

  it("states the conditions the measurement was taken under", () => {
    const section = coldStartSection();
    // Quoting ~3s without this is dishonest: a cold cluster would add the image load.
    expect(section).toMatch(/warm/i);
    expect(section).toMatch(/containerd|pre-loaded|already/i);
    // The one-time image load is a different figure and must be named as such.
    expect(section).toMatch(/4m32s|4m35s|one-time/i);
  });

  it("states the measurement method so the claim is reproducible", () => {
    const section = coldStartSection();
    expect(section).toMatch(/create-to-ready|create to ready/i);
    expect(section).toMatch(/first-command|first command/i);
    // The script lives in #589; naming a non-existent npm script here would be drift.
    expect(section).toContain("#589");
  });

  it("compares the measurement to the whitepaper bar", () => {
    const section = coldStartSection();
    expect(section).toMatch(/10 minutes|ten minutes/i);
  });
});
