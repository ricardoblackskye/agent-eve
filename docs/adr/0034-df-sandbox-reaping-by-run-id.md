# 0034 — sandbox reaping is keyed by run id (defense in depth)

**Date:** 2026-10-13
**Status:** Accepted

## Context

The OpenSandbox SDK client (`kill()` + `close()`) does not terminate a sandbox on its own, and a client
timeout during `Sandbox.create` can leave a sandbox the caller never saw (observed live: the server kept
building after the client gave up and had to be reaped by hand). `runCodingPhase` disposes in a `finally`,
but a leak that happens before the client returns a handle is invisible to it.

## Decision

Every sandbox the runner creates is labelled `metadata.run = <runId>`. A reaping pass
(`reapSandboxesByRun`) lists sandboxes filtered by that metadata and deletes them, run at run start to
reclaim orphans from a prior run with the same id. Delete failures are swallowed so a stuck orphan cannot
abort the run. The manager is injected for tests and built from the environment in deployment.

## Consequences

- The primary release is still `runCodingPhase`'s dispose(); reaping is defense in depth, not the main
  mechanism.
- Reaping is opt-in by driver: it only runs when `DF_SANDBOX_DRIVER=opensandbox`, so local/default runs
  never contact a sandbox.
- The metadata label is the contract that makes an orphan discoverable; dropping it would silently
  disable reaping.
