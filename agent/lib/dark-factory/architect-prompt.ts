import { isPageScopedStory } from "./plan-validator";

/**
 * The TARGET CONTRACT (#381 R2 Task 8) - the part of the Architect's prompt that says what may be targeted.
 *
 * It lives in its own module, as a pure function, for one reason: it is PROMPT BEHAVIOUR, and prompt
 * behaviour is testable. The line this replaces asked the model for "UI entrypoints under app/ or
 * components/" whenever a story mentioned "page" - so a story about the main page of a Vite/react-router
 * app produced targets called `src/components/Header.js` and `src/index.js`, neither of which existed.
 * Nothing had ever watched that instruction fail, because it was an anonymous string inside a 900-line
 * class. Here it can be asserted directly, and the assembled prompt can be asserted too.
 *
 * Every rule below is checkable against the file list discovery produced, and the plan validator enforces
 * the existence rule mechanically - so this states the contract rather than hoping for it.
 */
export interface TargetContractInput {
  /** Title and body together: the surface a story names is often only in the title. */
  storyText: string;
  /** The route discovery resolved, when it resolved one. */
  route?: string;
  /** The page discovery resolved. When this is set for a page-scoped story, it IS the target. */
  page?: string;
  /**
   * The role discovery assigned to each inspected file.
   *
   * A path maps to the discovery record at the Architect's call site (`{ role, evidence }`) and to a bare
   * role string in tests, so both shapes are accepted rather than importing either module's type: this
   * module only needs to recognise "shell" and "shared".
   */
  roles: Record<string, unknown>;
}

/** The role NAME from either accepted shape, or undefined when the value carries no role at all. */
function roleName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "role" in value) {
    const role = (value as { role?: unknown }).role;
    return typeof role === "string" ? role : undefined;
  }
  return undefined;
}

/**
 * How many forbidden paths are listed before the list is summarised.
 *
 * The contract is paid for out of the same prompt budget as the evidence, so its length has to be bounded:
 * a repository with fifty shared components must not push the plan prompt over budget.
 */
const MAX_FORBIDDEN_LISTED = 12;

export function buildTargetContract(input: TargetContractInput): string {
  const { storyText, route, page, roles } = input;
  const pageScoped = isPageScopedStory(storyText);
  const forbidden = Object.entries(roles)
    .filter(([, value]) => {
      const role = roleName(value);
      return role === "shell" || role === "shared";
    })
    .map(([path]) => path)
    .sort();

  const lines: string[] = [
    `Every "targetFiles[].path" MUST appear verbatim in the Existing files list. A path that is not in that ` +
      `list does not exist in this repository: do not invent one, do not translate an extension (a ".js" for ` +
      `an existing ".jsx"), and do not name a file because such a file usually exists in projects like this.`,
  ];

  if (pageScoped && page) {
    lines.push(
      `This story is scoped to one page, and the evidence above identifies it: ` +
        `${route ? `route "${route}" resolves to ` : ""}${page}. That file is the target.`,
    );
    if (forbidden.length > 0) {
      const listed = forbidden.slice(0, MAX_FORBIDDEN_LISTED);
      const rest = forbidden.length - listed.length;
      lines.push(
        `Forbidden targets for this story: ${listed.join(", ")}` +
          `${rest > 0 ? `, and ${rest} other shell or shared file(s)` : ""}. Each one is rendered on every ` +
          `route (a shell) or shared across pages, so changing it changes every page rather than the page ` +
          `this story names. If the story really is about one of them, its own text says so ("every page", ` +
          `"the header", "the layout") - this one does not.`,
      );
    }
    return lines.join("\n");
  }

  if (pageScoped) {
    // No page resolved. Saying nothing would leave the model free to invent one; the fallback below is
    // still better than that, but the guess has to be declared rather than made silently.
    lines.push(
      `This story is scoped to one page, but the evidence above does not identify which. Do not target a ` +
        `shell or a shared module on a guess. If the evidence names no page at all, prefer a UI entry point ` +
        `under app/ or components/, and say in the rationale that the surface was inferred.`,
    );
    return lines.join("\n");
  }

  lines.push(
    `If the story touches UI (a page, screen, browser or chat surface), prefer the UI entry point the ` +
      `evidence names. Fall back to an entry point under app/ or components/ only when the evidence names ` +
      `no UI file at all.`,
  );
  return lines.join("\n");
}
