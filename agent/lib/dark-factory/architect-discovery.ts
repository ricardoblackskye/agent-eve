/**
 * Dark Factory — Architect discovery (#381 R1).
 *
 * The Architect plans from a file LIST and cannot tell a page from a shared component from the application
 * shell, which is how two live runs produced a confidently wrong target - the second with a plausible
 * rationale for it. This module derives the answer from the repository instead.
 *
 * Deterministic by design: NO model call is made here. The evidence it returns is fed into the single
 * governed planning call, so cost stays one call per plan attempt.
 *
 * Two rules run through the whole module:
 *  - a role is derived from what a file DOES (its contents and who reaches it), never from its name;
 *  - the evidence is the composition path that proves the role, because a label without a path is just the
 *    assertion this work exists to replace.
 */

export type FileRole = "route" | "shell" | "page" | "shared" | "component";

export interface DiscoveredFile {
  /** Repo-relative, posix separators. */
  path: string;
  role: FileRole;
  /** The composition path that proves the role, cited by the plan's rationale. */
  evidence: string;
}

export interface DiscoveryInput {
  /** The repository's files, as the runner lists them. */
  files: string[];
  /** Injected so discovery can be tested without a filesystem, and be bounded by the caller. */
  readFile: (path: string) => Promise<string>;
  story: { title: string; body: string };
  /** Bounds the number of INSPECTION reads discovery itself performs. */
  maxInspectReads: number;
}

export interface DiscoveryResult {
  /** The composition chain for the named surface, if one could be resolved. */
  chain: DiscoveredFile[];
  /** Every file whose role was classified, chain files first. */
  classified: DiscoveredFile[];
  /** The resolved surface, or undefined when the story's surface could not be derived. */
  surface?: { route?: string; page?: string };
}

const SOURCE_FILE = /\.(?:jsx?|tsx?|mjs|cjs)$/i;
const NEXT_LAYOUT = /(^|\/)app\/(?:.*\/)?layout\.(?:jsx?|tsx?)$/i;
const NEXT_PAGE = /(^|\/)app\/(?:.*\/)?page\.(?:jsx?|tsx?)$/i;
/** Words a story uses for the default surface. "main page" and "home page" mean the "/" route. */
const DEFAULT_SURFACE_WORDS = /\b(main|home|landing|index|root)\b/i;

/**
 * Reading order when the inspection budget is smaller than the file list.
 *
 * Route tables come first because they name the surface, then shells because they explain what is NOT a
 * page, then pages, then everything else. A file's NAME is not evidence of its role, so this only decides
 * what gets READ - never what something IS.
 */
function discoveryPriority(path: string): number {
  if (/(^|\/)(routes?|router|routing)\./i.test(path)) return 0;
  if (/(^|\/)app\/(?:.*\/)?(layout|page)\./i.test(path)) return 1;
  if (/(^|\/)pages?\//i.test(path)) return 3;
  if (/(^|\/)components?\//i.test(path)) return 4;
  return 2;
}

/** Renders a slot for child routes, so it appears on every route rather than on one page. */
function rendersOutlet(content: string): boolean {
  return /<Outlet\b/.test(content) || /\buseOutlet\s*\(/.test(content) || /\{children\}/.test(content);
}

/** Declares the route table. */
function declaresRoutes(content: string): boolean {
  return (
    /<Route\b/.test(content) ||
    /\bcreateBrowserRouter\s*\(/.test(content) ||
    /\bcreateRoutesFromElements\s*\(/.test(content) ||
    /\buseRoutes\s*\(/.test(content)
  );
}

/** Relative import specifiers only: a bare package name says nothing about this repository. */
function relativeImports(content: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import\s*\()\s*["'](\.[^"']+)["']/g;
  for (const match of content.matchAll(re)) out.push(match[1]);
  return out;
}

/** Resolve a specifier against the importer, using the file list to infer the extension. */
function resolveImport(importer: string, specifier: string, files: string[]): string | undefined {
  const base = importer.split("/").slice(0, -1);
  const parts = specifier.split("/");
  const segments = [...base];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  const joined = segments.join("/");
  const candidates = [
    joined,
    `${joined}.tsx`,
    `${joined}.ts`,
    `${joined}.jsx`,
    `${joined}.js`,
    `${joined}/index.tsx`,
    `${joined}/index.ts`,
    `${joined}/index.jsx`,
    `${joined}/index.js`,
  ];
  return candidates.find((candidate) => files.includes(candidate));
}

/** Local component name -> resolved file, from a file's own imports. */
function namedImports(content: string, importer: string, files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const re = /import\s+([A-Za-z0-9_$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*["'](\.[^"']+)["']/g;
  for (const match of content.matchAll(re)) {
    const resolved = resolveImport(importer, match[2], files);
    if (resolved) out.set(match[1], resolved);
  }
  return out;
}

/** `<Route path="X" element={<Comp />} />` or `component={Comp}` -> route path to component name. */
function routeTable(content: string): Map<string, string> {
  const out = new Map<string, string>();
  const re =
    /<Route\b[^>]*?\bpath=["']([^"']+)["'][^>]*?(?:\belement=\{\s*<([A-Za-z0-9_$]+)|\bcomponent=\{\s*([A-Za-z0-9_$]+))/g;
  for (const match of content.matchAll(re)) {
    const component = match[2] ?? match[3];
    if (component) out.set(match[1], component);
  }
  return out;
}

/** Discover the composition chain and file roles for the surface a story names. */
export async function discoverArchitecture(input: DiscoveryInput): Promise<DiscoveryResult> {
  const { files, readFile, story, maxInspectReads } = input;

  const ordered = files.filter((f) => SOURCE_FILE.test(f)).sort((a, b) => {
    const byPriority = discoveryPriority(a) - discoveryPriority(b);
    return byPriority !== 0 ? byPriority : a.localeCompare(b);
  });

  const contents = new Map<string, string>();
  for (const path of ordered.slice(0, Math.max(0, maxInspectReads))) {
    try {
      contents.set(path, await readFile(path));
    } catch {
      // An unreadable file is not evidence of anything; skip it rather than guess.
    }
  }

  const classified = new Map<string, DiscoveredFile>();

  // 1. Shells. Derived from behaviour, so a file named MainPage that renders an outlet is still a shell.
  for (const [path, content] of contents) {
    if (rendersOutlet(content) || NEXT_LAYOUT.test(path)) {
      classified.set(path, {
        path,
        role: "shell",
        evidence: "renders an outlet, so it is rendered on every route",
      });
    }
  }

  // 2. The route table, and the component each route renders.
  let routeFilePath: string | undefined;
  let routes = new Map<string, string>();
  for (const [path, content] of contents) {
    if (!declaresRoutes(content)) continue;
    if (!routeFilePath) {
      routeFilePath = path;
      routes = routeTable(content);
      classified.set(path, {
        path,
        role: "route",
        evidence: `declares the route table (${routes.size} route${routes.size === 1 ? "" : "s"})`,
      });
    }
  }

  // 3. Pages: what the route table points at, resolved through that file's own imports.
  const pageForRoute = new Map<string, string>();
  if (routeFilePath) {
    const imports = namedImports(contents.get(routeFilePath) ?? "", routeFilePath, files);
    for (const [routePath, componentName] of routes) {
      const file = imports.get(componentName);
      if (!file) continue;
      pageForRoute.set(routePath, file);
      classified.set(file, {
        path: file,
        role: "page",
        evidence: `route "${routePath}" -> ${file}`,
      });
    }
  }
  for (const path of contents.keys()) {
    if (NEXT_PAGE.test(path) && !classified.has(path)) {
      classified.set(path, { path, role: "page", evidence: `next.js route page: ${path}` });
    }
  }

  // 4. Importers, so a component reached from more than one page can be called shared - with the pages named.
  const importedBy = new Map<string, string[]>();
  for (const [path, content] of contents) {
    for (const specifier of relativeImports(content)) {
      const resolved = resolveImport(path, specifier, files);
      if (!resolved) continue;
      importedBy.set(resolved, [...new Set([...(importedBy.get(resolved) ?? []), path])]);
    }
  }
  const pageFiles = new Set(
    [...classified.values()].filter((f) => f.role === "page").map((f) => f.path),
  );
  for (const [path, importers] of importedBy) {
    const fromPages = importers.filter((importer) => pageFiles.has(importer));
    if (fromPages.length >= 2) {
      classified.set(path, {
        path,
        role: "shared",
        evidence: `reached from ${fromPages.sort().join(", ")}`,
      });
    } else if (!classified.has(path) && importers.length > 0) {
      classified.set(path, {
        path,
        role: "component",
        evidence: `imported by ${importers.sort().join(", ")}`,
      });
    }
  }

  // 5. The surface the story names: an explicit route path beats a word for the default surface.
  const storyText = `${story.title}\n${story.body}`;
  let route: string | undefined;
  const explicit = [...pageForRoute.keys()]
    .filter((candidate) => candidate !== "/" && storyText.includes(candidate))
    .sort((a, b) => b.length - a.length)[0];
  if (explicit) route = explicit;
  else if (DEFAULT_SURFACE_WORDS.test(storyText) && pageForRoute.has("/")) route = "/";
  else if ([...pageForRoute.keys()].length === 1) route = [...pageForRoute.keys()][0];

  const page = route !== undefined ? pageForRoute.get(route) : undefined;

  // 6. The chain: route -> page -> the components that page composes, in import order.
  const chain: DiscoveredFile[] = [];
  for (const path of [routeFilePath, page]) {
    if (!path) continue;
    const entry = classified.get(path);
    if (entry) chain.push(entry);
  }
  if (page) {
    for (const specifier of relativeImports(contents.get(page) ?? "")) {
      const resolved = resolveImport(page, specifier, files);
      const entry = resolved ? classified.get(resolved) : undefined;
      if (entry) chain.push(entry);
    }
  }

  const chainPaths = new Set(chain.map((f) => f.path));
  const rest = [...classified.values()]
    .filter((f) => !chainPaths.has(f.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    chain,
    classified: [...chain, ...rest],
    surface:
      route === undefined && page === undefined ? undefined : { route, page },
  };
}
