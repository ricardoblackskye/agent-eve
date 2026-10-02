/**
 * Reference-page generators (#235).
 *
 * Each generator reads a SOURCE OF TRUTH and returns markdown, rendered by the
 * existing docs pipeline (`ReactMarkdown` + `remarkGfm` + `MermaidDiagram`, reused
 * from `app/documentation/[slug]/page.tsx`). No generated markdown is committed;
 * the page is derived when rendered, so it cannot drift.
 *
 * This file is the scaffold (RED): the generators return empty strings and
 * `listApiRoutes()` returns `[]`. GREEN implements them against the real sources.
 */

export interface ReferencePage {
  slug: string;
  title: string;
  derivedFrom: string;
  generate(): Promise<string>;
}

export function listReferencePages(): ReferencePage[] {
  return [
    {
      slug: "environment",
      title: "Environment variables",
      derivedFrom: ".env.example + application source",
      generate: () => Promise.resolve(""),
    },
    {
      slug: "api-routes",
      title: "API routes",
      derivedFrom: "app/api/**/route.ts + app/auth-gate.ts",
      generate: () => Promise.resolve(""),
    },
    {
      slug: "platform-seams",
      title: "Platform seams and adapters",
      derivedFrom: "provider/seam directories",
      generate: () => Promise.resolve(""),
    },
    {
      slug: "migrations",
      title: "Database migrations",
      derivedFrom: "db/migrations/",
      generate: () => Promise.resolve(""),
    },
    {
      slug: "tests-evals",
      title: "Test and eval inventory",
      derivedFrom: "tests/** + evals/**",
      generate: () => Promise.resolve(""),
    },
  ];
}

export function getReferencePage(slug: string): ReferencePage | undefined {
  return listReferencePages().find((p) => p.slug === slug);
}

/**
 * Machine-readable API-route inventory (decision #1): path + exported methods +
 * `protected` derived from the canonical `isProtectedPath` in `app/auth-gate.ts`.
 * Stubbed empty until GREEN.
 */
export interface ApiRoute {
  path: string;
  methods: string[];
  protected: boolean;
}

export function listApiRoutes(): ApiRoute[] {
  return [];
}
