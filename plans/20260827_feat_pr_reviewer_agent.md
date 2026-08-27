# feat/pr-reviewer-agent

## Objective
Add a new autonomous Agent capability to Agent Eve to perform PR code reviews for repos in GitHub.

## Tasks
- [ ] Setup test infrastructure for Vitest (if needed)
- [ ] Write failing tests for the PR reviewer subagent
- [ ] Push tests for review (create a pull request with the tests)
- [ ] Implement the PR reviewer subagent to make tests pass
- [ ] Set up GitHub Action to trigger the agent on pull requests (in .github/workflows)

## TDD Workflow (4-phase)
1. Setup test infra.
2. Write failing tests.
3. Push tests for review.
4. Implement to make tests GREEN.

## Notes
- Read the Vercel Eve docs where necessary.
- The agent must analyze code diffs for architectural anti-patterns, security risks, and off-by-one errors.
- The agent must post a single, high-level summary comment in the main PR conversation timeline.
- The agent must accurately cite line numbers from the diff headers (@@ -x,y +a,b @@).

## Verification
- [ ] Run tests and ensure they pass
- [ ] Verify that the GitHub Action works (by manually triggering or checking the workflow)