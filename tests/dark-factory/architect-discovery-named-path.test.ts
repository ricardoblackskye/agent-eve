import { describe, expect, it } from "vitest";
import {
  discoverArchitecture,
  type DiscoveryInput,
} from "../../agent/lib/dark-factory/architect-discovery";

/**
 * #726 - a path the story NAMES is the surface.
 *
 * Issue #12 on ricardoblackskye/local-promotion-site said, verbatim:
 *
 *   Add a 'Welcome to my site' to the bottom of the src/pages/BlogPostPage.ts page below all other
 *   content.
 *
 * It names the file outright and still resolved nothing - "[GATE] Parked on #12: the target could not be
 * justified". No code path considers a path the story names, so a story can identify its own target as
 * precisely as language allows and the discovery will not look.
 *
 * The fixture goes one step past the real repository: it has NO route table at all, because the rule must
 * not depend on one. A story naming an existing path resolves in any project shape - it needs no
 * framework knowledge whatsoever, which is what makes it the right first rule.
 *
 * The named path carries the WRONG EXTENSION on purpose, matching #12. A story is prose; `.ts` for a
 * `.tsx` file is a typo, not a different file, and the same extension inference that already resolves an
 * import should resolve this.
 */
const NO_ROUTER: Record<string, string> = {
  "index.html": '<div id="app"></div>',
  "src/main.ts": 'import { mount } from "./mount";',
  "src/mount.ts": "export function mount(): void {}",
  "src/pages/BlogPostPage.tsx":
    "export default function BlogPostPage() { return (<main><h1>Post</h1></main>); }",
};

function input(files: Record<string, string>, body: string): DiscoveryInput {
  return {
    files: Object.keys(files),
    readFile: async (path: string) => files[path] ?? "",
    story: { title: "Welcome line", body },
    maxInspectReads: 50,
  };
}

describe("#726 a path the story names", () => {
  it("resolves the surface to that path, without needing a route table", async () => {
    const result = await discoverArchitecture(
      input(
        NO_ROUTER,
        "Add a 'Welcome to my site' to the bottom of the src/pages/BlogPostPage.ts page below all other content.",
      ),
    );

    // Named as .ts, exists as .tsx - the same inference an import already gets.
    expect(result.surface?.page).toBe("src/pages/BlogPostPage.tsx");
  });

  it("still resolves nothing when the story names no path", async () => {
    const result = await discoverArchitecture(
      input(NO_ROUTER, "Make the site feel more professional."),
    );

    expect(result.surface).toBeUndefined();
  });
});
