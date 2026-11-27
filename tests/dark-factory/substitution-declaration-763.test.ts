import { describe, expect, it } from "vitest";
import { undeclaredSubstitution } from "../../agent/lib/dark-factory/plan-validator";
import { renderSubstitutionLine } from "../../agent/lib/dark-factory/plan-file";

/**
 * #780 (R3) - a substitution must be declared, not silent.
 *
 * The requirement: a plan that chooses a path other than the surface the story names must state which won and why,
 * at the top of the plan as ONE line; a silent substitution is refused. Where the story names a surface the plan
 * cannot write, it refuses with the reason rather than quietly changing something else.
 *
 * This mirrors the inputs the existing target-role rule already uses (`isPageScopedStory` + `context.surface.page`)
 * rather than inventing a second definition of "the surface the story names".
 */
const NAMED = "src/pages/HomePage.jsx";
const SHELL = "src/App.jsx";

describe("#780 R3 - an undeclared substitution is reported", () => {
  it("reports a plan that targets something other than the named surface, with no declaration", () => {
    // The mistake that shipped three times: the story says "home page", the plan names the shell.
    expect(undeclaredSubstitution({ targetPaths: [SHELL], namedSurface: NAMED })).toBe(true);
  });

  it("reports it when the named surface is one of several targets but still absent", () => {
    expect(undeclaredSubstitution({ targetPaths: ["docs/readme.md", SHELL], namedSurface: NAMED })).toBe(true);
  });
});

describe("#780 R3 - the controls, so this is a guard and not a wall", () => {
  it("CONTROL: the same substitution WITH a declaration is not reported", () => {
    // Without this, "refuse every substitution" would pass the cases above and the declaration would be pointless.
    expect(
      undeclaredSubstitution({
        targetPaths: [SHELL],
        namedSurface: NAMED,
        declaration: { chosen: SHELL, named: NAMED, reason: "the footer is rendered by the shell" },
      }),
    ).toBe(false);
  });

  it("CONTROL: a plan that targets the named surface itself is not reported", () => {
    expect(undeclaredSubstitution({ targetPaths: [NAMED], namedSurface: NAMED })).toBe(false);
  });

  it("CONTROL: an unknown named surface is not reported", () => {
    // Only a KNOWN named surface can be substituted away from. Demanding a declaration whenever discovery failed
    // would refuse plans for a reason the plan cannot act on, which is how a guard gets worked around.
    expect(undeclaredSubstitution({ targetPaths: [SHELL], namedSurface: null })).toBe(false);
    expect(undeclaredSubstitution({ targetPaths: [SHELL], namedSurface: undefined })).toBe(false);
  });

  it("CONTROL: a path spelled with a leading ./ still counts as the named surface", () => {
    expect(undeclaredSubstitution({ targetPaths: [`./${NAMED}`], namedSurface: NAMED })).toBe(false);
  });
});

describe("#780 R3 - the declaration renders as one line, at the top", () => {
  it("renders exactly the declared sentence", () => {
    expect(
      renderSubstitutionLine({
        chosen: SHELL,
        named: NAMED,
        reason: "the footer is rendered by the shell",
      }),
    ).toBe("Substituted: src/App.jsx for src/pages/HomePage.jsx, because the footer is rendered by the shell.");
  });

  it("is ONE line - the requirement's own wording, so it cannot become a paragraph", () => {
    const line = renderSubstitutionLine({ chosen: SHELL, named: NAMED, reason: "one reason only" });
    expect(line.includes("\n")).toBe(false);
  });
});
