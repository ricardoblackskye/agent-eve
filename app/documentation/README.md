# Documentation Subsystem

## Overview
Documentation subsystem index and diagramming package grouping static docs and derived reference pages.

## Interface
- `default function DocumentationIndex(): JSX.Element` [app/documentation/page.tsx:34-65]
- `MermaidDiagram({ code }: MermaidDiagramProps): JSX.Element` [app/documentation/mermaid-diagram.tsx:9-74]
- [reference](./reference/README.md) - Build-time reference page generators deriving markdown from codebase sources of truth
- [[slug]](./%5Bslug%5D/README.md) - Dynamic documentation viewer rendering markdown with interactive Mermaid diagrams

## Invariants
- Server component reading markdown titles from docs/pages/*.md at render time [app/documentation/page.tsx:15-32]
- MermaidDiagram client component dynamically imports mermaid library with dark theme and renders sanitized SVG [app/documentation/mermaid-diagram.tsx:16-45]

## Side Effects
- Synchronous filesystem directory listing of docs/pages on server [app/documentation/page.tsx:16-20]
- Client DOM SVG rendering in MermaidDiagram [app/documentation/mermaid-diagram.tsx:69-72]

## Verification
- Run: `npm test`
