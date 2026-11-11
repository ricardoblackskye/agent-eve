# Documentation Reference Generators

## Overview
Build-time reference page generators deriving markdown from codebase sources of truth.

## Interface
- `listReferencePages(): ReferencePage[]` [app/documentation/reference/generators.ts:274-307]
- `getReferencePage(slug: string): ReferencePage | undefined` [app/documentation/reference/generators.ts:309-311]
- `listApiRoutes(): ApiRoute[]` [app/documentation/reference/generators.ts:80-100]
- `ReferencePage, ApiRoute` interfaces [app/documentation/reference/generators.ts:19-30]

## Invariants
- Reference pages are generated on demand from local source files (.env.example, route files, migrations, tests) and never stored as duplicate files [app/documentation/reference/generators.ts:6-8]
- API route protection posture is derived directly from isProtectedPath in app/auth-gate.ts [app/documentation/reference/generators.ts:96, 114-116]

## Side Effects
- Reads filesystem files and directories under app/, db/migrations/, tests/, and evals/ [app/documentation/reference/generators.ts:38-53, 55-61]

## Verification
- Run: `npm test`
