# Fix: Production Evals hit the Vercel auth wall (#227)

**Branch:** `fix/ci-production-evals-227` (off `origin/main` @ `c76e7f0`)
**Issue:** #227

## Goal

Make `CI` on `main` green by giving the `production-evals` job the same
deployment-protection bypass that `preview-evals` already uses, and make a
missing bypass secret *loud* instead of silent in both eval workflows.

## Root cause (verified, not inferred)

`.github/workflows/ci.yml` lines 167-172 — the `production-evals` job runs:

```yaml
- name: Run evals against production
  env:
    EVE_EVAL_AUTH_TOKEN: ${{ secrets.EVE_EVAL_AUTH_TOKEN }}
  run: |
    npx eve eval --strict --junit .eve/junit-production.xml \
      --url https://agent-eve-gold.vercel.app
```

There is **no bypass mechanism**: no `VERCEL_PROTECTION_BYPASS` env var and no
`?x-vercel-protection-bypass=` on the URL. `agent-eve-gold.vercel.app` sits
behind Vercel Authentication (stated in `preview-evals.yml`'s own comment,
referencing #79), so the two evals that need a session (`smoke`, `auth-valid`)
fail with "Failed to create the session".

Evidence: merge SHA `c76e7f0`, `CI` run `36888278164`, job `110457852929` —
`auth-valid` ✗, `smoke` ✗, "Results: 7 passed, 2 failed (9 total)"; all other
jobs on that run passed.

`preview-evals.yml` already does both halves correctly (env var + query param),
so the working pattern exists in-repo — this is mirroring, not invention.

### Why CI never showed it before the merge

`production-evals` carries
`if: github.event_name == 'push' && github.ref == 'refs/heads/main'`. It reports
`skipped` on every PR, so no PR check-run can ever cover it. It is first
exercised on the merge commit — which is why #224 looked 12/13 green and then
went red on `main`.

### A second, independent defect in the same area

The bypass is applied behind `if [ -n "$VERCEL_PROTECTION_BYPASS" ]`. When the
secret is empty the step proceeds **with no bypass and no warning**, so the
failure presents as a flaky eval rather than a missing configuration. That is
what made the PR-phase failure take so long to diagnose. Both workflows get a
guard.

## Intended fix

1. `ci.yml` `production-evals`: add `VERCEL_PROTECTION_BYPASS` to the step env
   and build `TARGET_URL` the same way `preview-evals.yml` does, appending the
   bypass correctly whether or not the URL already has a query string.
2. Both eval workflows: when the bypass secret is empty, emit a GitHub
   `::warning::` annotation naming the likely cause (secret unset, or the
   Vercel secret regenerated and not re-copied).
3. `README.md`: add `VERCEL_PROTECTION_BYPASS` to the list of GitHub Action
   secrets the eval workflows require. It is currently absent, which is a large
   part of why this was invisible.

**Deliberate non-goal:** extracting the URL-building into a shared composite
action. Two call sites with five lines each do not justify the indirection, and
the repo's convention is inline steps. The duplication is guarded by tests
(below) instead.

## Tasks (TDD)

This is a CI-configuration change: there is no runtime behaviour to drive, so
the RED anchor is a **structural assertion on the workflow YAML** — the same
approach the repo already uses for `.env.example` coverage and lint config.
Load `config-lint-tdd` during implementation.

1. **RED** — `tests/workflow-eval-bypass.test.ts`:
   - assert `ci.yml`'s `production-evals` step env includes
     `VERCEL_PROTECTION_BYPASS`;
   - assert its run script appends `x-vercel-protection-bypass` to the target
     URL;
   - assert both eval workflows emit a warning when the secret is empty;
   - assert `README.md` names `VERCEL_PROTECTION_BYPASS` among the required
     GitHub Action secrets.
   Run it: the `ci.yml` assertions must FAIL for the right reason (no bypass
   plumbing), not because a fixture cannot load.
2. **GREEN** — make the three edits above; re-run to pass.
3. **REFACTOR** — keep the two workflows' bypass blocks structurally identical
   so the test can assert them uniformly.

## Files likely to change

| File | Change |
|------|--------|
| `.github/workflows/ci.yml` | `production-evals` gains the bypass env + URL param + empty-secret warning |
| `.github/workflows/preview-evals.yml` | empty-secret warning only (bypass already correct) |
| `README.md` | add `VERCEL_PROTECTION_BYPASS` to the required-secrets list |
| `tests/workflow-eval-bypass.test.ts` | new structural tests |

## Validation

- `npx vitest run` — full suite green, including the new workflow tests.
- `npm run typecheck` — clean.
- Local lint gate on changed files: `npx -y cspell@8 --config .cspell.json`
  and `markdown-table-formatter` on `README.md`.
- **The real proof is post-merge:** `CI` on `main` for the fix's merge commit
  must be green. This cannot be proven on the PR, because `production-evals`
  is skipped there by design — the plan states that limitation rather than
  implying the PR run proves it.
- Optional pre-merge proof: dispatch the `CI` workflow manually on the branch
  (`workflow_dispatch`) if enabled, or run the eval command locally against
  production with the bypass set.

## Risks / open questions

- **Is production meant to be publicly reachable?** If `agent-eve-gold` should
  be open, the correct fix is disabling Vercel Authentication for production (a
  Vercel project setting, not code) and the bypass becomes unnecessary. The
  code fix is correct either way; it assumes production stays protected. Needs
  a decision from the user — recorded on #227.
- **`EVE_EVAL_AUTH_TOKEN` must be a valid agent bearer token** for `auth-valid`
  to be meaningful. If it is unset, that eval fails for a second reason and the
  fix will look incomplete. Cannot be verified from here; will be reported, not
  guessed.
- **False-pass masking:** `auth-invalid` asserts that a bad token is rejected,
  and an auth wall rejects everything. Until the bypass works, that eval can
  pass for the wrong reason. After the fix, confirm it still passes — if it
  flips, the earlier pass was spurious.
- **YAML parsing in tests:** prefer a real YAML parser if one is already a
  dependency; otherwise scope a text assertion to the job block rather than
  matching bare substrings repo-wide (a repo-wide substring match would pass on
  `preview-evals.yml`'s existing content and never exercise `ci.yml`).

## Out of scope

- The PR-time Preview Evals failure (a missing GitHub Actions secret, since
  supplied by the user).
- #213 / #212 feature work (merged in #224).