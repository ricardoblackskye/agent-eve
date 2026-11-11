# Evals Helpers

## Overview
Evaluation helper functions and verdict types for validating agent response structure and intent.

## Interface
- `smoke-reply.ts:ReplyVerdict` - Evaluation outcome type (`{ ok: boolean; message: string }`)
- `smoke-reply.ts:evaluateSmokeReply(reply: unknown): ReplyVerdict` - Validates that an agent greeting response is non-empty and describes capabilities

## Invariants
- [smoke-reply.ts:evaluateSmokeReply] Non-string or whitespace-only reply returns `{ ok: false, message: 'the agent replied with nothing' }`
- [smoke-reply.ts:evaluateSmokeReply] Reply missing capability keywords (`/help|assist|support|can do|can help/i`) returns `{ ok: false }` with truncated reply text up to 80 characters
- [smoke-reply.ts:SAYS_WHAT_IT_CAN_DO] Anti-vacuity guard (#444, #624): Bare greetings without capability verbs fail evaluation

## Side Effects
- None

## Verification
- Run: `npm test`

