import { describe, expect, it } from "vitest";
import {
  isPageScopedStory,
  isShellScopedStory,
} from "../../agent/lib/dark-factory/plan-validator";

/**
 * #381 R2 AC3 - telling a page-scoped story from a shell-scoped one.
 *
 * This distinction is the whole rule. "Never target the shell" is easy to write and wrong: some stories are
 * ABOUT the shell, and refusing them would block legitimate work. The shell-scoped reading therefore WINS,
 * which is why the precedence cases below matter more than the happy path.
 */
describe("story scope (#381 R2)", () => {
  it("reads the stories that actually failed as page-scoped", () => {
    // WebFeedPOC #166: "the main page" meant src/pages/HomePage.jsx, and the plan targeted a shared component.
    expect(isPageScopedStory("Change the heading on the main page")).toBe(true);
    expect(isPageScopedStory("The home page heading should read Hello.")).toBe(
      true,
    );
    // #168 round 2: the same wording, planned against src/App.jsx - the shell.
    expect(isPageScopedStory("Update the landing page copy")).toBe(true);
  });

  it("reads an explicitly named route as page-scoped", () => {
    expect(
      isPageScopedStory("The /settings route renders the wrong title"),
    ).toBe(true);
    expect(isPageScopedStory("On the checkout screen the total is stale")).toBe(
      true,
    );
  });

  it("reads an EVERY-route story as shell-scoped", () => {
    expect(isShellScopedStory("Add a footer on every page")).toBe(true);
    expect(isShellScopedStory("Show a banner on all pages")).toBe(true);
    expect(isShellScopedStory("Style the navigation bar")).toBe(true);
    expect(isShellScopedStory("The header should be sticky")).toBe(true);
  });

  it("gives the SHELL reading precedence, so a legitimate shell change is not refused", () => {
    // Both readings are present. If the page reading won, this would be refused and the change blocked.
    expect(isPageScopedStory("Add a footer on every page")).toBe(false);
    expect(isPageScopedStory("Show a banner on all pages")).toBe(false);
    expect(isPageScopedStory("Update the header on every page")).toBe(false);
  });

  it("does not claim a backend story is about a surface", () => {
    expect(isPageScopedStory("Fix the retry count in the lease reaper")).toBe(
      false,
    );
    expect(isShellScopedStory("Fix the retry count in the lease reaper")).toBe(
      false,
    );
    expect(isPageScopedStory("Migrate the tenant table")).toBe(false);
  });

  it("is not fooled by the word page in an unrelated phrase", () => {
    // A database "page" is not a UI surface. This is the cost of a text signal, so it is pinned deliberately
    // rather than left to chance: the rule must not fire on pagination work.
    expect(isPageScopedStory("Increase the database page size to 8kb")).toBe(
      false,
    );
  });

  it("tolerates empty and whitespace input", () => {
    expect(isPageScopedStory("")).toBe(false);
    expect(isShellScopedStory("   ")).toBe(false);
  });
});
