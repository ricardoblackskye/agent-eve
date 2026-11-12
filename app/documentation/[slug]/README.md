# Documentation Detail Page

## Overview
Dynamic documentation viewer rendering server-side markdown with interactive Mermaid diagram support.

## Interface
- `generateStaticParams(): { slug: string }[]` [app/documentation/[slug]/page.tsx:24-27]
- `dynamicParams = false` [app/documentation/[slug]/page.tsx:29]
- `default async function DocumentationPage(props): Promise<JSX.Element>` [app/documentation/[slug]/page.tsx:31-89]

## Invariants
- Sanitizes slug against ^[a-z0-9-]+$; returns 404 notFound() on invalid slugs [app/documentation/[slug]/page.tsx:37]
- Reads markdown from docs/pages/${slug}.md or invokes dynamic generator from getReferencePage; 404s if neither exists [app/documentation/[slug]/page.tsx:39-47]
- Intercepts language-mermaid code fences to render interactive MermaidDiagram components [app/documentation/[slug]/page.tsx:63-66]

## Side Effects
- Reads markdown files from docs/pages directory on the server [app/documentation/[slug]/page.tsx:42]

## Verification
- Run: `npm test`
