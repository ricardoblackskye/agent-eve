import { describe, expect, it } from "vitest";
import { discoverArchitecture, type DiscoveryInput } from "../../agent/lib/dark-factory/architect-discovery";

/**
 * #381 R2 Task 7 — discovery must resolve the route shape a real app uses.
 *
 * The first live run against WebFeedPOC #169 parked rather than planning, and the cause was only visible by
 * reading the target repository. Its routes are:
 *
 *   <Route path="/" element={<App />}>        // "/" renders the SHELL: App renders an <Outlet>
 *     <Route index element={<HomePage />} />  // the page "the main page" means is an INDEX CHILD
 *
 * and `src/App.test.jsx` ALSO declares <Routes>, sorting before `main.jsx`. Both are reproduced here, because
 * a simplified fixture is what let this ship in the first place.
 */
const REPO: Record<string, string> = {
  "src/main.jsx": [
    'import React from "react";',
    "import { BrowserRouter, Routes, Route } from \"react-router-dom\";",
    'import App from "./App.jsx";',
    'import HomePage from "./pages/HomePage.jsx";',
    'import CategoryPage from "./pages/CategoryPage.jsx";',
    "ReactDOM.createRoot(document.getElementById(\"root\")).render(",
    "  <BrowserRouter>",
    "    <Routes>",
    '      <Route path="/" element={<App />}>',
    "        <Route index element={<HomePage />} />",
    '        <Route path="category/:categoryName" element={<CategoryPage />} />',
    "      </Route>",
    "    </Routes>",
    "  </BrowserRouter>,",
    ");",
  ].join("\n"),

  // The shell: rendered on every route, which is why it must never be the page.
  "src/App.jsx": [
    'import { Outlet } from "react-router-dom";',
    "function App() {",
    '  return (<div><nav>nav</nav><Outlet /></div>);',
    "}",
    "export default App;",
  ].join("\n"),

  "src/pages/HomePage.jsx": [
    "export default function HomePage() { return (<main><h1>Home</h1></main>); }",
  ].join("\n"),

  "src/pages/CategoryPage.jsx": [
    "export default function CategoryPage() { return (<main><h1>Category</h1></main>); }",
  ].join("\n"),

  // A TEST that declares routes, and sorts before main.jsx: it must not be taken as the route table.
  "src/App.test.jsx": [
    'import { render } from "@testing-library/react";',
    'import { MemoryRouter, Routes, Route } from "react-router-dom";',
    'import App from "./App";',
    'import HomePage from "./pages/HomePage";',
    'it("renders", () => {',
    "  render(",
    "    <MemoryRouter>",
    "      <Routes>",
    '        <Route path="/" element={<App />}>',
    "          <Route index element={<HomePage />} />",
    "        </Route>",
    "      </Routes>",
    "    </MemoryRouter>,",
    "  );",
    "});",
  ].join("\n"),
};

const FILES = Object.keys(REPO);

function input(over: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return {
    files: FILES,
    readFile: async (path: string) => REPO[path] ?? "",
    story: { title: "Create a new sub-heading on the main page", body: "It should be bold." },
    maxInspectReads: 12,
    ...over,
  };
}

describe("discovery against a real route shape (#381 R2 Task 7)", () => {
  it("resolves the INDEX CHILD as the page for the route, not the shell that renders it", async () => {
    const result = await discoverArchitecture(input());

    // "/" renders App, which renders an <Outlet>: the page is the index child, not the parent element.
    expect(result.surface?.route).toBe("/");
    expect(result.surface?.page).toBe("src/pages/HomePage.jsx");
    expect(result.surface?.page).not.toBe("src/App.jsx");
  });

  it("still knows the parent is a SHELL", async () => {
    const result = await discoverArchitecture(input());
    const shell = result.classified.find((f) => f.path === "src/App.jsx");
    expect(shell?.role).toBe("shell");
  });

  it("never takes a TEST file as the route table", async () => {
    const result = await discoverArchitecture(input());
    // App.test.jsx declares Routes and sorts first; if it were used, the page would come from a test fixture.
    expect(result.chain[0]?.path).toBe("src/main.jsx");
    expect(result.classified.some((f) => f.path === "src/App.test.jsx" && f.role === "route")).toBe(false);
  });

  it("keeps the composition chain route -> page", async () => {
    const result = await discoverArchitecture(input());
    const paths = result.chain.map((f) => f.path);
    expect(paths).toContain("src/main.jsx");
    expect(paths).toContain("src/pages/HomePage.jsx");
    // The shell renders on every route, so it must not be presented as the chain's page.
    expect(result.chain.filter((f) => f.role === "page").map((f) => f.path)).toEqual([
      "src/pages/HomePage.jsx",
    ]);
  });
});
