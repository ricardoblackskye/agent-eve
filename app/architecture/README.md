# Architecture Route

## Overview
Backward-compatibility page component redirecting legacy /architecture requests to /documentation.

## Interface
- `default function ArchitectureRedirect(): void` [app/architecture/page.tsx:7-9]

## Invariants
- Issues unconditional Next.js navigation redirect to /documentation (#234) [app/architecture/page.tsx:8]

## Side Effects
- Triggers Next.js navigation redirect exception to /documentation [app/architecture/page.tsx:8]

## Verification
- Run: `npm test`
