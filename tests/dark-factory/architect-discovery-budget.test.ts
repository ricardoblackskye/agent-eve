import { describe, expect, it } from "vitest";
import { discoverArchitecture } from "../../agent/lib/dark-factory/architect-discovery";

/**
 * #381 R2 Task 7b - the inspection BUDGET must be spent on application source, not on tests.
 *
 * The live run parked a second time even after the index-child fix, and a probe over the real checkout
 * said why: WebFeedPOC has 20 testish files and an `e2e/` directory, and "e2e/..." sorts before "src/...".
 * The whole 12-file inspection budget went to `e2e/*.spec.ts` and `e2e/fixtures.js`, so `src/main.jsx` -
 * the actual route table - was never read at all. Discovery then reported no surface, correctly, from no
 * evidence.
 *
 * These are the same defects measured, not read: a fixture where tests outnumber and out-sort the app.
 */

const ROUTE_FILE = `import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from './App.jsx'
import HomePage from './pages/HomePage.jsx'

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<App />}>
        <Route index element={<HomePage />} />
      </Route>
    </Routes>
  </BrowserRouter>,
)
`;

const APP = `import { Outlet } from 'react-router-dom'
export default function App() { return <div><header>shell</header><Outlet /></div> }
`;

const HOME = `export default function HomePage() { return <main>home</main> }
`;

/** Twelve spec files and a fixture, all of which sort before "src/" - exactly like WebFeedPOC. */
function testHeavyRepo(): Record<string, string> {
  const files: Record<string, string> = {
    "src/main.jsx": ROUTE_FILE,
    "src/App.jsx": APP,
    "src/pages/HomePage.jsx": HOME,
    "e2e/fixtures.js": "export const baseUrl = 'http://localhost:5173'\n",
    "e2e/helpers.ts": "export function go() {}\n",
  };
  for (const name of [
    "about", "accessibility", "cart", "category-filter", "home", "pagination",
    "product-card-responsiveness", "product-page", "responsive-shell", "search-sort",
  ]) {
    files[`e2e/${name}.spec.ts`] = "import { test } from '@playwright/test'\ntest('x', async () => {})\n";
  }
  files["tests/jsLinting.test.ts"] = "import { describe } from 'vitest'\ndescribe('lint', () => {})\n";
  return files;
}

const story = { title: "Dark Factory Test Issue 7", body: "create a new sub-heading on the main page of the application" };

describe("#381 R2 Task 7b - test files must not consume the inspection budget", () => {
  it("resolves the page even when testish files outnumber and out-sort the app", async () => {
    const repo = testHeavyRepo();
    const result = await discoverArchitecture({
      story,
      files: Object.keys(repo),
      readFile: async (p) => repo[p] ?? "",
      maxInspectReads: 12,
    });
    // Before the fix the route table was never read, so this was undefined and the Architect parked.
    expect(result.surface?.page).toBe("src/pages/HomePage.jsx");
    expect(result.surface?.route).toBe("/");
  });

  it("does not spend the budget on a test or spec file", async () => {
    const repo = testHeavyRepo();
    const result = await discoverArchitecture({
      story,
      files: Object.keys(repo),
      readFile: async (p) => repo[p] ?? "",
      maxInspectReads: 12,
    });
    const inspected = result.classified.map((f) => f.path);
    expect(inspected.some((p) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p))).toBe(false);
    expect(inspected.some((p) => p.startsWith("e2e/"))).toBe(false);
  });

  it("still reports the entry file as the route table, not a test that renders Routes", async () => {
    const repo = testHeavyRepo();
    repo["e2e/aaa.spec.ts"] = "import { Routes, Route } from 'react-router-dom'\nexport const r = <Routes><Route path=\"/\" element={<HomePage />} /></Routes>\n";
    const result = await discoverArchitecture({
      story,
      files: Object.keys(repo),
      readFile: async (p) => repo[p] ?? "",
      maxInspectReads: 12,
    });
    expect(result.classified.find((f) => f.role === "route")?.path).toBe("src/main.jsx");
  });
});
