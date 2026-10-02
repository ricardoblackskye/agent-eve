// Generates tests/fixtures/df-css-baseline.json — the resolved
// selector+declaration bag of app/globals.css BEFORE the #241 refactor.
// The migration test asserts the refactored file resolves to the same bag,
// which is the non-vacuous proof that the refactor changed structure only,
// not behavior. Run once before committing the test; re-run only if the
// source classes legitimately change.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRules } from "../tests/support/cssResolve.mjs";

const ROOT = process.cwd();
const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
const bag = resolveRules(css)
  .map(([s, d]) => `${s} => ${d}`)
  .sort();

mkdirSync(join(ROOT, "tests", "fixtures"), { recursive: true });
writeFileSync(
  join(ROOT, "tests", "fixtures", "df-css-baseline.json"),
  JSON.stringify(bag, null, 2) + "\n",
);
console.log(`baseline entries: ${bag.length}`);
