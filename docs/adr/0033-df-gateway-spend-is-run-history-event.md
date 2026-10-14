# 0033 — sandbox spend is a first-class run-history event

**Date:** 2026-10-13
**Status:** Accepted

## Context

The governed gateway sits in front of every sandbox model call and decides BEFORE any upstream spend.
The runner's in-process cost gate already records refusals on the run; sandbox authoring spend must be
visible on the SAME run, not only in a log, or it is the one spend the dashboards cannot see.

## Decision

Add a `run.cost` `RunEvent` type (the `RunEventType` union and allow-list) and record each forwarded
gateway call as one, carrying `costUsd` (the governor's upper-bound estimate) and `stage: "worker"`.
Refusals reuse the existing `recordCostRefusal` (`run.terminal` + `costRefusal` code). The recorder
swallows history-write errors so an outage can never fail a forwarded call.

## Consequences

- Sandbox authoring spend is attributable per run and per gate, alongside every other cost.
- The event type is a closed vocabulary; a future change to what `costUsd` means is a reviewable ADR, not
  a silent field tweak.
- The gateway still requires explicit governance configuration to forward at all (ADR 0030), so this
  event only appears when spend actually occurred.
