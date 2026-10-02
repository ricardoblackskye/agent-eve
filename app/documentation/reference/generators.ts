/**
 * Reference-page generators (#235).
 *
 * Each generator reads a SOURCE OF TRUTH and returns markdown, rendered by the
 * existing docs pipeline (`ReactMarkdown` + `remarkGfm` + `MermaidDiagram`, reused
 * from `app/documentation/[slug]/page.tsx`). No generated markdown is committed;
 * the page is derived when rendered, so it cannot drift.
 *
 * `listApiRoutes()` is the machine-readable gate inventory (decision #1): path and
 * methods come from the route files, posture from the canonical `isProtectedPath`
 * in `app/auth-gate.ts` — not a heuristic parse.
 */
import fs from "node:fs";
import path from "node:path";
import { isProtectedPath } from "../../auth-gate";

const ROOT = process.cwd();

export interface ReferencePage {
  slug: string;
  title: string;
  derivedFrom: string;
  generate(): Promise<string>;
}

export interface ApiRoute {
  path: string;
  methods: string[];
  protected: boolean;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;

// ---------------------------------------------------------------------------
// file-system helpers
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function readUtf8(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function isAppSource(p: string): boolean {
  const rel = path.relative(ROOT, p);
  if (
    rel.startsWith("tests") ||
    rel.startsWith("evals") ||
    rel.startsWith("node_modules") ||
    rel.startsWith(".next")
  ) {
    return false;
  }
  return /\.(ts|tsx|js|mjs)$/.test(p);
}

// ---------------------------------------------------------------------------
// API routes (machine-readable — decision #1)
// ---------------------------------------------------------------------------

export function listApiRoutes(): ApiRoute[] {
  const apiDir = path.join(ROOT, "app", "api");
  const routes: ApiRoute[] = [];
  for (const file of walk(apiDir)) {
    if (!file.endsWith("route.ts")) continue;
    const rel = path
      .relative(path.join(ROOT, "app", "api"), file)
      .replace(/\\/g, "/");
    const routePath = "/api/" + rel.replace(/route\.ts$/, "").replace(/\/$/, "");
    const text = readUtf8(file);
    const methods = HTTP_METHODS.filter((m) =>
      new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${m}\\b`).test(text),
    );
    routes.push({
      path: routePath,
      methods,
      protected: isProtectedPath(routePath),
    });
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

function apiRoutesMarkdown(): string {
  const routes = listApiRoutes();
  const rows = routes
    .map(
      (r) =>
        `| \`${r.path}\` | ${r.methods.join(", ") || "—"} | ${r.protected ? "protected" : "public"} |`,
    )
    .join("\n");
  return `> Generated from \`app/api/**/route.ts\` and \`app/auth-gate.ts\` — do not edit.

## API routes

${routes.length} routes. Posture is computed from the canonical \`isProtectedPath\` in
\`app/auth-gate.ts\` (fail-closed: anything not explicitly public is protected).

| Path | Methods | Posture |
|------|--------|---------|
${rows}
`;
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

function documentedEnvVars(): string[] {
  const text = readUtf8(path.join(ROOT, ".env.example"));
  const vars: string[] = [];
  const re = /^\r?([A-Z][A-Z0-9_]*)\s*=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) vars.push(m[1]);
  return vars;
}

function sourceEnvVars(): Set<string> {
  const vars = new Set<string>();
  const re = /(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g;
  for (const file of walk(path.join(ROOT, "app"))) {
    if (!isAppSource(file)) continue;
    const text = readUtf8(file);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) vars.add(m[1]);
  }
  return vars;
}

function environmentMarkdown(): string {
  const documented = documentedEnvVars();
  const used = sourceEnvVars();
  const rows = documented
    .map((k) => `| \`${k}\` | ${used.has(k) ? "yes" : "—"} |`)
    .join("\n");
  return `> Generated from \`.env.example\` and application source — do not edit.

## Environment variables

${documented.length} variables documented in \`.env.example\`. The "Used in source"
column shows whether application code references the variable via \`process.env.*\`.

| Variable | Used in source |
|----------|---------------|
${rows}
`;
}

// ---------------------------------------------------------------------------
// Platform seams and adapters
// ---------------------------------------------------------------------------

function platformSeamsMarkdown(): string {
  const dir = path.join(ROOT, "agent", "lib", "dark-factory");
  const basenames = walk(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => path.basename(f, ".ts"));
  const impls = (kind: "sqlite" | "postgres" | "console") =>
    new Set(basenames.filter((b) => b.endsWith(`-${kind}`)));
  const sqlite = impls("sqlite");
  const postgres = impls("postgres");
  const console = impls("console");
  const seamRe = /(?:provider|store|control|state)$/;
  const seams = basenames
    .filter((b) => seamRe.test(b) && !/(sqlite|postgres|console)$/.test(b))
    .sort();
  const rows = seams
    .map(
      (s) =>
        `| \`${s}\` | ${sqlite.has(`${s}-sqlite`) ? "✓" : "—"} | ${
          postgres.has(`${s}-postgres`) ? "✓" : "—"
        } | ${console.has(`${s}-console`) ? "✓" : "—"} |`,
    )
    .join("\n");
  return `> Generated from \`agent/lib/dark-factory/**\` — do not edit.

## Platform seams and adapters

Each seam interface (provider / store / control / state) has driver implementations
for \`sqlite\`, \`postgres\` and an in-memory \`console\` driver, selected at runtime by
\`DF_CONTROL_DRIVER\` / the tenant-store driver config.

| Seam | sqlite | postgres | console |
|------|:------:|:--------:|:-------:|
${rows}
`;
}

// ---------------------------------------------------------------------------
// Database migrations
// ---------------------------------------------------------------------------

function migrationsMarkdown(): string {
  const dir = path.join(ROOT, "db", "migrations");
  const files = walk(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => path.basename(f))
    .sort();
  const rows = files
    .map((f) => {
      const header = readUtf8(path.join(dir, f))
        .split("\n")
        .find((l) => l.trim().startsWith("--"))
        ?.replace(/^--\s?/, "")
        .trim();
      return `| \`${f}\` | ${header || "(no header comment)"} |`;
    })
    .join("\n");
  return `> Generated from \`db/migrations/\` — do not edit.

## Database migrations

${files.length} migrations applied in filename order.

| Migration | Description |
|-----------|-------------|
${rows}
`;
}

// ---------------------------------------------------------------------------
// Test and eval inventory
// ---------------------------------------------------------------------------

function testsEvalsMarkdown(): string {
  const tests = walk(path.join(ROOT, "tests"))
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
    .sort();
  const evals = walk(path.join(ROOT, "evals"))
    .filter((f) => f.endsWith(".eval.ts"))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
    .sort();
  const list = (items: string[]) => items.map((i) => `- \`${i}\``).join("\n");
  return `> Generated from \`tests/**\` and \`evals/**\` — do not edit.

## Test and eval inventory

Each test file declares one or more \`describe(...)\` blocks; each eval is a
\`*.eval.ts\` file under \`evals/\`.

### Tests (${tests.length})

${list(tests)}

### Evals (${evals.length})

${list(evals)}
`;
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

export function listReferencePages(): ReferencePage[] {
  return [
    {
      slug: "environment",
      title: "Environment variables",
      derivedFrom: ".env.example + application source",
      generate: () => Promise.resolve(environmentMarkdown()),
    },
    {
      slug: "api-routes",
      title: "API routes",
      derivedFrom: "app/api/**/route.ts + app/auth-gate.ts",
      generate: () => Promise.resolve(apiRoutesMarkdown()),
    },
    {
      slug: "platform-seams",
      title: "Platform seams and adapters",
      derivedFrom: "agent/lib/dark-factory/**",
      generate: () => Promise.resolve(platformSeamsMarkdown()),
    },
    {
      slug: "migrations",
      title: "Database migrations",
      derivedFrom: "db/migrations/",
      generate: () => Promise.resolve(migrationsMarkdown()),
    },
    {
      slug: "tests-evals",
      title: "Test and eval inventory",
      derivedFrom: "tests/** + evals/**",
      generate: () => Promise.resolve(testsEvalsMarkdown()),
    },
  ];
}

export function getReferencePage(slug: string): ReferencePage | undefined {
  return listReferencePages().find((p) => p.slug === slug);
}
