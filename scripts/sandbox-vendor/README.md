# Sandbox Vendor

## Overview
Offline artifact vendoring script and digest lock ensuring reproducible OpenSandbox container images and chart assets without runtime network access.

## Interface
- `vendor.sh` - Bash vendoring script populating local container tarball cache from artifacts.lock.json (usage: bash scripts/sandbox-vendor/vendor.sh [--force])
- `artifacts.lock.json` - Committed JSON lock file pinning OpenSandbox chart version (1.2.0), CRD paths, binary version constraints (docker, kubectl), and container image digests (execd, egress)

## Invariants
- [vendor.sh] Refuses to cache any container image whose inspected sha256 digest fails to match artifacts.lock.json
- [vendor.sh] Converts Windows MSYS paths to mixed form (cygpath -m) for native Docker and Python binaries
- [artifacts.lock.json] Strictly pins upstream image digests and chart versions to eliminate non-deterministic runtime downloads

## Side Effects
- [vendor.sh] Invokes Docker daemon (docker pull, docker image inspect, docker save); writes image archives into scripts/sandbox-vendor/cache/*.tar

## Verification
- Run: `npm test`
