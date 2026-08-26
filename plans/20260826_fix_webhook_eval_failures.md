# Fix Webhook Eval Failures

## Issue
The webhook eval is failing because:
1. The ping event was being processed after the repository check, causing a 400 error when no repository was present in the ping payload.
2. The authorization header in the Eve API call had a typo (three asterisks instead of two) and was not properly formatted.
3. The release-manager.config.json did not have a configuration for the test repo "test/repo" used in the eval.

## Plan
1. Move the ping event check to occur before parsing the payload and checking for repository.
2. Fix the authorization header string (remove extra asterisk and use correct template literal).
3. Add a configuration for the test repo "test/repo" in release-manager.config.json.

## Steps
1. Adjust the handler in `app/api/github/webhook/route.ts` to check for ping event early.
2. Fix the authorization header in the same file.
3. Add the test repo configuration to `release-manager.config.json`.
4. Run the webhook eval to verify the fix.
5. Ensure typecheck and build still pass.
6. Commit and push the branch, then open a PR for issue #32.

## Verification
- The webhook eval should pass (all gates).
- Typecheck and build should pass.
- No regressions in other evals.