# Evals

## Overview
Eve eval configuration and scenario definitions for deterministic agent smoke testing and health validation.

## Interface
- `evals.config.ts:default` - Eval framework runner configuration via defineEvalConfig
- `smoke.eval.ts:default` - Smoke evaluation definition verifying agent boot and response greeting
- [helpers](./helpers/README.md) - Evaluation helper utilities and response assertion functions

## Invariants
- [evals.config.ts] Configured without an LLM judge model to ensure deterministic execution
- [smoke.eval.ts:test] Issues test greeting, asserts successful completion via t.succeeded(), and checks reply validity using evaluateSmokeReply

## Side Effects
- [smoke.eval.ts:t.send] Dispatches asynchronous test message to local agent runner and receives reply

## Verification
- Run: `npm test`
