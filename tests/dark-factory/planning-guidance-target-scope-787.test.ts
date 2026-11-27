import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planningGuidanceForPrompt } from "../../agent/lib/dark-factory/planning-guidance";

/**
 * #787 - the architect needs a target-scope rule: when uncertain, include the co-located spec.
 *
 * R4 (#781) measured the identical story planned twice against one commit producing different target sets - one
 * including the co-located spec, one omitting it while its prose promised to add it. Both passed validation, and
 * under R2 the omission BLOCKS the write, so which plan an approver receives decides whether the change arrives with
 * its test updated.
 *
 * The rule is asserted against the SHARED guidance, because the repair prompt's version of this instruction already
 * existed and Run B was never repaired - its plan passed validation, so a rule that only fires on repair never
 * applied. A rule that only fires on repair cannot shape the first answer.
 */
const GUIDANCE = planningGuidanceForPrompt();

describe("#787 - the guidance sets the target scope", () => {
  it("says the co-located spec for the file being changed belongs in targetFiles", () => {
    expect(GUIDANCE).toContain("co-located spec");
    expect(GUIDANCE).toContain("targetFiles");
  });

  it("says to include it when uncertain - the default that addresses the measured divergence", () => {
    // Run B did not omit the spec out of policy; it omitted it out of uncertainty. A rule that leaves the uncertain
    // case to the model's judgement reproduces the divergence it exists to remove.
    expect(GUIDANCE.toLowerCase()).toContain("uncertain");
  });

  it("says WHY the uncertain case resolves toward inclusion", () => {
    // The asymmetry is the argument and belongs in the prompt, not only in a commit message: the approved set is what
    // a run MAY write, so an unneeded file costs nothing while a missing one blocks the write.
    expect(GUIDANCE.toLowerCase()).toMatch(/may write|permission|blocks the write|costs nothing/);
  });
});

describe("#787 - the guidance stays provider- and repo-agnostic", () => {
  it("names no repository, vendor or framework", () => {
    // Pinned as an ABSENCE, the shape used for R2's "does not widen the approved set": the standing principle is one
    // a later well-meaning edit relaxes, so it is asserted rather than remembered.
    const named = ["agent-eve", "WebFeedPOC", "local-promotion-site", "github", "vercel", "react", "next", "vitest"];
    const found = named.filter((token) => GUIDANCE.toLowerCase().includes(token.toLowerCase()));

    expect(found).toEqual([]);
  });

  it("names no file extension or path, so it holds for any language", () => {
    const found = [".jsx", ".tsx", ".ts", ".py", "src/"].filter((token) => GUIDANCE.includes(token));

    expect(found).toEqual([]);
  });
});

describe("#787 - the repair path cannot drift from the guidance", () => {
  it("derives the repair instruction from the same exported text", () => {
    // Asserted as AGREEMENT between the two paths. A duplicated sentence can drift; a shared export cannot. The
    // source-level half is deliberately paired with tsc and the suite, never standing alone (the lesson from #704,
    // where a wiring guard reported a call present and correctly ordered while the file did not compile).
    const agent = readFileSync(resolve(process.cwd(), "agent/lib/dark-factory/architect-agent.ts"), "utf8");

    expect(agent).toContain("targetScopeRule");
  });
});
