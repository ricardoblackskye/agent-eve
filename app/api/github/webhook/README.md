# GitHub Webhook Route

## Overview
Inbound GitHub webhook receiver dispatching release notes triggers, sprint reports, and Dark Factory autonomous execution loops.

## Interface
- `POST(request: NextRequest): Promise<NextResponse>` [app/api/github/webhook/route.ts:191-795]
- `GET(request: NextRequest): Promise<NextResponse>` [app/api/github/webhook/route.ts:796]

## Invariants
- Rejects non-POST methods with HTTP 405 Method Not Allowed [app/api/github/webhook/route.ts:193-195]
- Requires matching repo in release-manager.config.json and validates x-hub-signature-256 HMAC when required by deployment policy [app/api/github/webhook/route.ts:227-284]
- Release notes subagent triggers only on pull_request action for merged PRs; non-merged actions are acknowledged without subagent dispatch [app/api/github/webhook/route.ts:311-320]
- Sanitizes structural identifiers (owner, repo, issueNumber) and fences untrusted text before delegating to Eve session API [app/api/github/webhook/route.ts:503-521, 654-688]
- Never runs the factory loop inline inside the serverless HTTP request; dispatches to out-of-band runner/session [app/api/github/webhook/route.ts:592-598]

## Side Effects
- Reads and caches release-manager.config.json from disk [app/api/github/webhook/route.ts:32-38]
- Outbound HTTP POST to Eve agent session API at /eve/v1/session [app/api/github/webhook/route.ts:386-390, 557-561, 731-735]
- Appends events to RunHistoryStore, interacts with ControlStore, and writes GitHub labels via GitHub API [app/api/github/webhook/route.ts:156-176]

## Verification
- Run: `npm test`
