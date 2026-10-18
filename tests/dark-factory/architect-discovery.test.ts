import { describe, expect, it } from "vitest";
import { discoverArchitecture, type DiscoveryInput } from "../../agent/lib/dark-factory/architect-discovery";

/**
 * #381 R1 — discovery, against a fixture shaped like the case that actually failed.
 *
 * WebFeedPOC #166 targeted a SHARED component because the story said "the main page", and #168 round 2 moved
 * the target to the application SHELL with a confident rationale for it. Both are reproduced here, because a
 * simplified stand-in would not have caught either.
 */
const FIXTURE: Record<string, string> = {
  // The shell: rendered on EVERY route, so a heading here appears on every page.
  "src/App.jsx": [
    'import { Outlet, Link } from "react-router-dom";',
    "export default function App() {",
    "  return (",
    "    <div>",
    '      <nav><Link to="/">Home</Link></nav>',
    "      <Outlet />",
    "    </div>",
    "  );",
    "}",
  ].join("\n"),

  // The route table: "/" is the surface "the main page" means.
  "src/routes.jsx": [
    'import { Routes, Route } from "react-router-dom";',
    'import HomePage from "./pages/HomePage";',
    'import CategoryPage from "./pages/CategoryPage";',
    "export default function AppRoutes() {",
    "  return (",
    "    <Routes>",
    '      <Route path="/" element={<HomePage />} />',
    '      <Route path="/category/:slug" element={<CategoryPage />} />',
    "    </Routes>",
    "  );",
    "}",
  ].join("\n"),

  // The default page, composing the shared component.
  "src/pages/HomePage.jsx": [
    'import ProductList from "../components/ProductList";',
    "export default function HomePage() {",
    '  return (<main><h1>Home</h1><ProductList /></main>);',
    "}",
  ].join("\n"),

  // A SECOND page composing the same component: this is what makes ProductList shared, not "the main page".
  "src/pages/CategoryPage.jsx": [
    'import ProductList from "../components/ProductList";',
    "export default function CategoryPage() {",
    '  return (<main><h1>Category</h1><ProductList /></main>);',
    "}",
  ].join("\n"),

  "src/components/ProductList.jsx": [
    "export default function ProductList() {",
    "  return (<ul><li>item</li></ul>);",
    "}",
  ].join("\n"),
};

const FILES = Object.keys(FIXTURE);

function input(over: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return {
    files: FILES,
    readFile: async (path: string) => FIXTURE[path] ?? "",
    story: { title: "Change the heading on the main page", body: "The home page heading should read Hello." },
    maxInspectReads: 12,
    ...over,
  };
}

function roleOf(result: Awaited<ReturnType<typeof discoverArchitecture>>, path: string) {
  return result.classified.find((f) => f.path === path)?.role;
}

function evidenceOf(result: Awaited<ReturnType<typeof discoverArchitecture>>, path: string) {
  return result.classified.find((f) => f.path === path)?.evidence ?? "";
}

describe("discoverArchitecture (#381 R1)", () => {
  it("marks a file that renders an outlet as the SHELL, not a page", async () => {
    const result = await discoverArchitecture(input());
    expect(roleOf(result, "src/App.jsx")).toBe("shell");
    // A shell is rendered on every route, so the evidence must say so rather than call it a page.
    expect(evidenceOf(result, "src/App.jsx")).toMatch(/every route|shell/i);
    expect(roleOf(result, "src/App.jsx")).not.toBe("page");
  });

  it("marks a file that composes a component from more than one page as SHARED", async () => {
    const result = await discoverArchitecture(input());
    expect(roleOf(result, "src/components/ProductList.jsx")).toBe("shared");
    // The evidence must name the pages that prove it - that is what makes it evidence rather than a label.
    const evidence = evidenceOf(result, "src/components/ProductList.jsx");
    expect(evidence).toMatch(/HomePage/);
    expect(evidence).toMatch(/CategoryPage/);
  });

  it("resolves the surface the story names to the ROUTE and the page that renders it", async () => {
    const result = await discoverArchitecture(input());
    expect(result.surface?.route).toBe("/");
    expect(result.surface?.page).toBe("src/pages/HomePage.jsx");
    expect(roleOf(result, "src/pages/HomePage.jsx")).toBe("page");
  });

  it("returns the composition chain route -> page -> component", async () => {
    const result = await discoverArchitecture(input());
    const paths = result.chain.map((f) => f.path);
    expect(paths[0]).toBe("src/routes.jsx");
    expect(paths).toContain("src/pages/HomePage.jsx");
    expect(paths).toContain("src/components/ProductList.jsx");
    // The shell is NOT the page the story names, and must not appear as one.
    expect(result.chain.filter((f) => f.role === "page").map((f) => f.path)).toEqual([
      "src/pages/HomePage.jsx",
    ]);
  });

  it("derives roles from the repository, never from a file's name", async () => {
    // A file called MainPage.tsx that is reached from every route is still a shell.
    const files = {
      ...FIXTURE,
      "src/MainPage.jsx": [
        'import { Outlet } from "react-router-dom";',
        "export default function MainPage() { return (<div><Outlet /></div>); }",
      ].join("\n"),
    };
    const result = await discoverArchitecture(
      input({ files: Object.keys(files), readFile: async (p: string) => files[p] ?? "" }),
    );
    expect(roleOf(result, "src/MainPage.jsx")).toBe("shell");
  });

  it("derives its answer from file CONTENTS, not from filenames", async () => {
    // Same paths, different contents: the routes file no longer maps "/" to HomePage, so the surface must
    // change. A filename-based implementation would still say HomePage.
    const files = {
      ...FIXTURE,
      "src/routes.jsx": [
        'import { Routes, Route } from "react-router-dom";',
        'import CategoryPage from "./pages/CategoryPage";',
        "export default function AppRoutes() {",
        '  return (<Routes><Route path="/" element={<CategoryPage />} /></Routes>);',
        "}",
      ].join("\n"),
    };
    const result = await discoverArchitecture(
      input({ files: Object.keys(files), readFile: async (p: string) => files[p] ?? "" }),
    );
    expect(result.surface?.page).toBe("src/pages/CategoryPage.jsx");
  });

  it("bounds its own inspection reads", async () => {
    let reads = 0;
    const result = await discoverArchitecture(
      input({
        maxInspectReads: 2,
        readFile: async (p: string) => {
          reads += 1;
          return FIXTURE[p] ?? "";
        },
      }),
    );
    expect(reads).toBeLessThanOrEqual(2);
    // Bounded means it may not resolve a surface it cannot afford to inspect - and must say so rather than guess.
    expect(result.surface === undefined || typeof result.surface.route === "string").toBe(true);
  });

  it("states the absence of a chain rather than inventing one", async () => {
    const result = await discoverArchitecture(
      input({ files: ["README.md", "src/util.ts"], readFile: async () => "export const x = 1;" }),
    );
    expect(result.chain).toEqual([]);
    expect(result.surface).toBeUndefined();
  });
});
