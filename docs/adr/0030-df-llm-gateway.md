# 0030 — Sandbox model calls are governed at an in-repo gateway

**Date:** 2026-10-13
**Status:** Accepted

## Context

A coding-agent CLI inside a sandbox calls its model provider directly. That bypasses `CostGovernor` and
`llm-policy`, which the in-process loop applies at every call site. Serving the largest spend in a run
outside the gate would be a **fail-open governance regression**, and it is why authoring and its
governance ship in the same release (#281).

## Decision

Route the CLI's model calls back through an in-repo, OpenAI-compatible gateway, by overriding the CLI's
base-URL knob rather than intercepting traffic:

- **Reuse `runGovernedLlmCall` verbatim** (reserve, run, settle). A second reserve/settle
  implementation is how the two drift and one of them silently stops accounting.
- **Refuse BEFORE forwarding.** The governor decides before any upstream request, so a refused call
  costs nothing — #270's acceptance criterion, exercised through the CLI path.
- **Fail CLOSED when governance is not configured.** The in-process cost gate treats "ungoverned" as
  "behave as before", which is right for a pre-existing local path and wrong for this endpoint: the
  gateway exists only to keep sandbox spend gated, so with no governor it refuses
  (`not_configured`) instead of forwarding.
- **The model allow-list is deny-by-default**: with nothing configured, no model is forwarded.
- **`tenantId` is forwarded** from the lease, so sandbox spend can never fall silently to GLOBAL.
- **One generic 401 for every lease failure.** Absent and unknown leases are indistinguishable, so the
  endpoint cannot be probed as a lease-state oracle.
- **Leases are opaque, run-bound and revocable**, and the provider key never enters the deciding
  module: the caller injects the forwarding function, closing over the key server-side. An upstream
  failure returns a generic error, echoing no provider detail back into the sandbox.
- **Egress is deny-by-default** at the sandbox, allowing the gateway host, so a missing base-URL
  override cannot silently reach a provider and spend.

## Consequences

- The gateway becomes a new critical path: a run cannot author without it, so it needs its own auth and
  an availability story.
- Sandbox authoring spend is attributed per category and tenant like every other call, and visible in
  the existing cost dashboards.
- R3 (#282) replaces the lease STORAGE with OpenSandbox's credential vault; this check and every caller
  stay unchanged, because R2 already treats the lease as opaque and the key as server-side.
- A misconfigured deployment refuses rather than degrades: no caps provisioned means refusals, not
  ungoverned spend.
