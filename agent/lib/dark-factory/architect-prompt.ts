import type { FileRole } from "./architect-discovery";

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
  /** The role discovery assigned to each inspected file. */
  roles: Record<string, FileRole>;
}

export function buildTargetContract(_input: TargetContractInput): string {
  throw new Error("not implemented");
}
