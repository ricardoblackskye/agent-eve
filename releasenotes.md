# Release Notes

## v0.1.0 (2026-08-25)

### CI/Infrastructure

- [PR #29]: MegaLinter pipeline integration — adds automated code quality, spelling, YAML/JSON/markdown linting, copy-paste detection, and GitHub Actions security auditing to CI

## v0.1.1 (2026-08-26)

### CI/Infrastructure

- Remediate the initial MegaLinter findings with scoped spelling/link configuration, safer copy-paste thresholds, immutable action pins, and read-only workflow permissions

## v0.1.2 (2026-08-27)

### Bug Fixes

- [PR #81]: Fix preview evals triggering on production deployments — previously preview-evals.yml ran on every deployment_status including production, causing 401 failures against Vercel Authentication and leaving red checks on main after merges (Issue #79)

- [PR #81]: Fix release notes workflow failing silently — now surfaces failures properly for easier diagnosis (Issue #80)