import { describe, expect, it } from "vitest";
import {
  discoverArchitecture,
  type DiscoveryInput,
} from "../../agent/lib/dark-factory/architect-discovery";

/**
 * #726 - a page reached through a path ALIAS.
 *
 * The second measured cause in ricardoblackskye/local-promotion-site. Its `src/App.tsx` imports every
 * page through the `@/` alias:
 *
 *   import BlogPostPage from "@/pages/BlogPostPage";
 *
 * and `relativeImports` matches RELATIVE specifiers only - by design, because "a bare package name says
 * nothing about this repository". An alias is neither bare nor relative: `@/` is a path INTO this
 * repository, declared in `tsconfig.json` (`compilerOptions.paths`) or the bundler's `resolve.alias`.
 *
 * Without it the route never resolves to a file, so the surface is lost for every page in an aliased
 * project - which is most React/TS projects in existence.
 *
 * The alias map is supplied by the caller rather than parsed here: which of tsconfig / vite / jest
 * declares it is the caller's question, and the module already takes its filesystem access injected.
 */
const ALIASED: Record<string, string> = {
  "src/App.tsx": [
    'import { Routes, Route } from "react-router-dom";',
    'import BlogPostPage from "@/pages/BlogPostPage";',
    "export default function App() {",
    '  return (<Routes><Route path="/blog/:slug" element={<BlogPostPage />} /></Routes>);',
    "}",
  ].join("\n"),

  "src/pages/BlogPostPage.tsx":
    "export default function BlogPostPage() { return (<main><h1>Post</h1></main>); }",
};

describe("#726 a page reached through a path alias", () => {
  it("resolves an aliased import using the caller's alias map", async () => {
    const input: DiscoveryInput = {
      files: Object.keys(ALIASED),
      readFile: async (path: string) => ALIASED[path] ?? "",
      story: { title: "Blog", body: "Add a welcome line to the bottom of the blog post page." },
      maxInspectReads: 50,
      aliases: { "@/": "src/" },
    };

    const result = await discoverArchitecture(input);

    expect(result.surface?.page).toBe("src/pages/BlogPostPage.tsx");
  });
});
