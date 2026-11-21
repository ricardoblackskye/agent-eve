import { describe, expect, it } from "vitest";
import {
  discoverArchitecture,
  type DiscoveryInput,
} from "../../agent/lib/dark-factory/architect-discovery";

/**
 * #726 — a route whose page component is declared in the SAME file.
 *
 * The first run against ricardoblackskye/local-promotion-site (#11) parked with "no page could be
 * identified". Its App.tsx is the route table AND the home page:
 *
 *   import { Routes, Route } from "react-router-dom";
 *   function HomePage() { return (<><Header /><main id="main-content">...</main></>); }
 *   export default function App() {
 *     return (<Routes><Route path="/" element={<HomePage />} /></Routes>);
 *   }
 *
 * `HomePage` is declared locally, so it is not in the file's IMPORTS - and the route loop resolves a
 * route element through imports alone (`imports.get(componentName)`; `if (!file) continue;`). The route
 * is skipped, `pageForRoute` never gains "/", and a story about "the main page" has no surface.
 *
 * A component declared in the route file IS that route's page: the file renders it, so the file is the
 * page's home. This is the difference between naming a surface and naming nothing.
 */
const SPA: Record<string, string> = {
  "src/main.tsx": [
    'import React from "react";',
    'import { BrowserRouter } from "react-router-dom";',
    'import App from "./App";',
    'ReactDOM.createRoot(document.getElementById("root")!).render(',
    "  <BrowserRouter><App /></BrowserRouter>,",
    ");",
  ].join("\n"),

  // Both the route table and the home page, in one file - which is what the module must cope with.
  "src/App.tsx": [
    'import { Routes, Route } from "react-router-dom";',
    'import Header from "@/components/layout/Header";',
    "function HomePage() {",
    '  return (<><Header /><main id="main-content"><h1>Home</h1></main></>);',
    "}",
    "export default function App() {",
    '  return (<Routes><Route path="/" element={<HomePage />} /></Routes>);',
    "}",
  ].join("\n"),

  "src/components/layout/Header.tsx":
    "export default function Header() { return (<header>h</header>); }",
};

function input(repo: Record<string, string>, body: string): DiscoveryInput {
  return {
    files: Object.keys(repo),
    readFile: async (path: string) => repo[path] ?? "",
    story: { title: "Welcome line", body },
    maxInspectReads: 50,
  };
}

describe("#726 a page declared in the route table's own file", () => {
  it("resolves the surface when the route element is a locally-declared component", async () => {
    const result = await discoverArchitecture(
      input(SPA, "Add a 'Welcome to my site' to the bottom of the main page below all other content."),
    );

    // "the main page" is a default-surface word, so the route is "/" - and its page lives in the route
    // file, because that is the file that declares and renders it.
    expect(result.surface?.route).toBe("/");
    expect(result.surface?.page).toBe("src/App.tsx");
  });
});
