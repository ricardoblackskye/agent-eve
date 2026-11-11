# Release Notes Page

## Overview
Client page rendering formatted release notes markdown fetched from /api/releasenotes.

## Interface
- `default function ReleaseNotesPage(): JSX.Element` [app/releasenotes/page.tsx:7-21]

## Invariants
- Renders markdown using ReactMarkdown and remarkGfm [app/releasenotes/page.tsx:18]

## Side Effects
- Client-side fetch request to /api/releasenotes on component mount [app/releasenotes/page.tsx:11-14]

## Verification
- Run: `npm test`
