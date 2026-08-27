# Fix PR Reviewer Agent Issues and MegaLinter Errors

## Overview

This plan outlines the steps to fix the issues identified by the PR reviewer agent in PR #36 and the MegaLinter errors in the `feat/pr-reviewer-agent-clean` branch.

## Issues from PR Reviewer Agent Feedback

### 1. `.github/workflows/pr-reviewer.yml`

- **Node.js version**: Change from `'24'` to `'22'` or `'lts/*'` (Node.js 24 does not exist yet).
- **Cache key**: Make the `npm ci` cache explicit (optional but recommended for reproducibility).
- **Newline at end of file**: Ensure the file ends with a newline.

### 2. `agent/subagents/pr-reviewer/agent.ts`

- **Hardcoded model name**: Remove duplication by centralizing the model name (e.g., in an environment variable or config file).
- **Excessive context window**: Reduce `modelContextWindowTokens` from 1,048,576 to a more reasonable value (e.g., 256,000).
- **Unused import**: Verify and remove unused imports if any.

### 3. `scripts/pr-reviewer.js`

- **Synchronous file I/O**: Replace `fs.readFileSync` with asynchronous version (`fs.promises.readFile`) or keep if acceptable at startup (but prefer async).
- **Top-level await**: Wrap the main logic in an async function or add `"type": "module"` to `package.json`.
- **Missing timeout on fetch**: Add a timeout (e.g., 30 seconds) to the `fetch` call to get the PR diff.
- **Hardcoded model (duplicate)**: Centralize the model name (same as in agent.ts).
- **Prompt injection risk**: Sanitize the PR diff by escaping backticks before interpolating into the prompt.
- **Response validation**: Add defensive checks for `openrouterData.choices[0].message.content`.
- **Comment endpoint**: Consider changing from `/issues/{prNumber}/comments` to `/pulls/{prNumber}/comments` for semantic correctness (though both work).
- **Large diff handling**: Implement truncation or summarization for diffs exceeding a safe token limit (e.g., 100KB).
- **Missing User-Agent header**: Add a `User-Agent` header required by GitHub API.

### 4. `tests/pr-reviewer.test.ts`

- **Dynamic import after mocks**: Refactor to avoid fragile timing dependencies (e.g., use `vi.hoisted`).
- **Test depth**: Enhance tests to verify behavior, not just existence.

## MegaLinter Errors

From the latest MegaLinter run, the following descriptors reported errors:

- **JavaScript (Prettier)**: 1 error
- **Repository (Checkov)**: 1 error
- **Spell (CSpell)**: 1 error
- **YAML (Prettier)**: 1 error
- **YAML (Yamllint)**: 3 errors

### Steps to Fix MegaLinter Errors

1. **JavaScript/Prettier**:
   - Run `npx prettier --write` on the offending JavaScript file(s).
   - Alternatively, run the Prettier linter via MegaLinter with the `APPLY_FIXES: BASIC` or `APPLY_FIXES: ALL` option.

2. **Repository/Checkov**:
   - Review the Checkov error report to identify the infrastructure-as-code issue (likely in a `.yml`, `.yaml`, `.tf`, or `.json` file).
   - Fix the underlying issue (e.g., incorrect IAM policy, missing encryption, etc.).

3. **Spell (CSpell)**:
   - Identify the misspelled word from the CSpell report.
   - Either correct the spelling or add the word to `cspell.json` (if it's a legitimate term, e.g., a project-specific name).

4. **YAML/Prettier**:
   - Run `npx prettier --write` on the offending YAML file(s).

5. **YAML (Yamllint)**:
   - Fix the yamllint errors (e.g., syntax issues, indentation, trailing spaces) in the reported YAML file(s).

## Implementation Plan

### Phase 1: Fix PR Reviewer Agent Code

1. Update `.github/workflows/pr-reviewer.yml`:
   - Change `node-version: '24'` to `node-version: '22'`.
   - Add `cache: npm` with explicit key if needed (optional).
   - Ensure newline at end of file.

2. Update `agent/subagents/pr-reviewer/agent.ts`:
   - Introduce a configuration mechanism for the model name (e.g., read from `process.env.MODEL_NAME` or a config file).
   - Set `modelContextWindowTokens` to 256000.
   - Remove unused imports.

3. Update `scripts/pr-reviewer.js`:
   - Replace `fs.readFileSync` with `fs.promises.readFile` (or keep sync if justified and add a comment).
   - Wrap the main logic in an async function (or set `"type": "module"` in `package.json`).
   - Add timeout to `fetch` for PR diff (using `AbortSignal.timeout(30000)`).
   - Centralize model name (use same config as agent.ts).
   - Sanitize `prDiff` by replacing backticks with escaped versions (or use a template literal that avoids interpolation issues).
   - Add validation for OpenRouter response before accessing `choices[0].message.content`.
   - Evaluate changing comment endpoint to `/pulls/{prNumber}/comments` (keep `/issues` for now if the comment is general).
   - Implement diff truncation if length exceeds a threshold (e.g., 50KB).
   - Add `User-Agent: agent-eve-pr-reviewer` header to GitHub API calls.

4. Update `tests/pr-reviewer.test.ts`:
   - Refactor to avoid dynamic import after mocks.
   - Add behavioral tests (e.g., mock the OpenRouter API and verify comment posting).

### Phase 2: Fix MegaLinter Errors

1. **JavaScript/Prettier**:
   - Run `npx prettier --list-different "**/*.js"` to identify offending files.
   - Run `npx prettier --write` on those files.

2. **Repository/Checkov**:
   - Run `npx checkov -f <offending_file>` to see details.
   - Fix the infrastructure-as-code issue.

3. **Spell (CSpell)**:
   - Run `npx cspell "**/*"` to find misspelled words.
   - Correct spelling or add to `cspell.json`.

4. **YAML/Prettier**:
   - Run `npx prettier --list-different "**/*.yml" "**/*.yaml"` to identify offending files.
   - Run `npx prettier --write` on those files.

5. **YAML (Yamllint)**:
   - Run `npx yamllint "**/*.yml" "**/*.yaml"` to see errors.
   - Fix each error (indentation, syntax, etc.).

### Phase 3: Verification

1. Run the PR reviewer agent locally or in a test to ensure it works without syntax errors.
2. Run MegaLinter locally to confirm all errors are resolved.
3. Commit and push changes to the branch.
4. Verify that all CI checks pass (including MegaLinter).

## Notes

- The plan follows the user's preference for plan-first TDD: create plan, commit plan only, push branch, then implement.
- Each fix should be committed separately with clear messages.
- Avoid mixing style fixes with functional changes unless necessary.
- After implementing, run the relevant linters/tests to verify each fix.

## References

- PR reviewer agent feedback: [GitHub PR #36 review](https://github.com/ricardoblackskye/agent-eve/pull/36#issuecomment-...)
- MegaLinter documentation: https://megalinter.io/
