# Release Notes API Route

## Overview
Release notes API endpoint fetching live releasenotes.md from GitHub with local filesystem fallback.

## Interface
- `GET(): Promise<NextResponse>` [app/api/releasenotes/route.ts:42-62]

## Invariants
- Attempts live GitHub API fetch using GH_RELEASE_TOKEN/GITHUB_TOKEN before falling back to local disk [app/api/releasenotes/route.ts:9, 45-56]

## Side Effects
- Outbound HTTPS GET to GitHub contents API (api.github.com/repos/ricardoblackskye/agent-eve/contents/releasenotes.md) [app/api/releasenotes/route.ts:19-22]
- Local filesystem read of releasenotes.md upon GitHub API failure [app/api/releasenotes/route.ts:35-37]

## Verification
- Run: `npm test`
