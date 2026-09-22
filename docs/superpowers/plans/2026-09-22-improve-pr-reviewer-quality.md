# Improve PR Reviewer Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate false positives, subjective architectural nitpicks, and Node.js runtime hallucinations in automated PR reviews by adding runtime grounding, anti-hallucination guardrails, structured severity tagging, and a self-correction verification filter to `scripts/pr-reviewer.js`.

**Architecture:** Refactor `scripts/pr-reviewer.js` into modular components: environment detection (Node.js single-threaded awareness), hardened system prompt with anti-quota and precision rules, structured severity tagging (`[BLOCKER]` vs `[SUGGESTION]`), and a verification filter that eliminates hallucinated concurrency and pedantic design claims before posting to GitHub.

**Tech Stack:** Node.js (ES modules), Vitest, OpenRouter API (DeepSeek Chat), GitHub REST API.

## Global Constraints
- Target branch: `feat/improve-pr-reviewer-quality-#182`.
- Preserves all 27 existing tests in `tests/pr-reviewer.test.ts` without regressions.
- Non-reasoning model default (`PR_REVIEW_MODEL || "deepseek/deepseek-chat"`) preserved per issue #87 invariants.
- Strict token budgeting and diff sanitization constraints (`sanitizeForPrompt`) preserved.

---

### Task 1: Environment Grounding & Anti-Hallucination System Prompt

**Files:**
- Modify: `scripts/pr-reviewer.js:180-220`
- Test: `tests/pr-reviewer.test.ts`

**Interfaces:**
- Consumes: `codeDiff: string`
- Produces: `detectRuntimeEnvironment(diff: string): string`, `buildSystemPrompt(runtimeContext?: string): string`

- [ ] **Step 1: Write the failing tests in `tests/pr-reviewer.test.ts`**

```ts
describe("PR Reviewer Grounding and Anti-Hallucination Rules (#182)", () => {
  it("includes Node.js runtime grounding and single-threaded awareness in the system prompt", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/single-threaded/i);
    expect(content).toMatch(/thread safety/i);
  });

  it("instructs the reviewer to output LGTM when code is clean and defect-free", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/LGTM/i);
    expect(content).toMatch(/HIGH PRECISION OVER HIGH RECALL|do not fabricate/i);
  });

  it("forbids subjective architectural nitpicks and bikeshedding in guidelines", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/VERIFY BEFORE ASSERTING/i);
    expect(content).toMatch(/DO NOT NITPICK OR DICTATE TASTE/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pr-reviewer.test.ts`
Expected: FAIL (missing grounding text in `scripts/pr-reviewer.js`)

- [ ] **Step 3: Update `scripts/pr-reviewer.js` with runtime grounding and critical review guidelines**

```javascript
/**
 * Detect runtime environment from diff filenames to provide targeted runtime context.
 */
function detectRuntimeEnvironment(diff) {
  const isNode = /\.(ts|js|mjs|cjs|jsx|tsx|json)($|\b)/.test(diff);
  const isDotNet = /\.(cs|csproj|sln)($|\b)/.test(diff);
  const isPython = /\.(py|pyi)($|\b)/.test(diff);

  if (isNode) {
    return "Node.js / TypeScript / JavaScript (single-threaded event loop runtime)";
  }
  if (isDotNet) {
    return ".NET / C# (multi-threaded runtime)";
  }
  if (isPython) {
    return "Python runtime";
  }
  return "General software project";
}

function buildSystemPrompt(runtimeContext) {
  return [
    `You are a pragmatic principal software engineer reviewing this code diff.`,
    `Target Runtime Environment: ${runtimeContext}`,
    ``,
    `CRITICAL REVIEW GUIDELINES:`,
    `1. HIGH PRECISION OVER HIGH RECALL: Only report concrete, demonstrable bugs, actual security vulnerabilities, or severe logic defects. If the diff is clean, sound, and defect-free, explicitly approve with "LGTM" and do NOT fabricate minor or subjective feedback.`,
    `2. RUNTIME ACCURACY: For Node.js/JavaScript, the runtime executes on a single-threaded event loop. Do NOT flag "thread safety" or concurrent memory corruption on standard in-memory JavaScript data structures (Set, Map, Array, Object).`,
    `3. VERIFY BEFORE ASSERTING: Check if a capability is already provided. For example, if constructor options or parameter objects allow injecting dependencies or options, do NOT claim Dependency Injection or configurability is missing.`,
    `4. DO NOT NITPICK OR DICTATE TASTE: Do not flag subjective architectural preferences (e.g. debating Singleton vs Factory vs Registry) unless it causes an actual memory leak or unhandled exception. Avoid bike-shedding on patterns that provide reasonable encapsulation for the scope of the PR.`,
    `5. EXACT CITATIONS: You MUST reference the exact line numbers from the diff headers (@@ -x,y +a,b @@) for any reported defect.`,
  ].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pr-reviewer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/pr-reviewer.js tests/pr-reviewer.test.ts
git commit -m "feat(pr-reviewer): add Node.js runtime grounding and anti-hallucination guidelines"
```

---

### Task 2: Structured Severity Tagging (`[BLOCKER]` vs `[SUGGESTION]`)

**Files:**
- Modify: `scripts/pr-reviewer.js:200-260`
- Test: `tests/pr-reviewer.test.ts`

**Interfaces:**
- Consumes: Model review output string
- Produces: `formatStructuredReview(content: string): string`

- [ ] **Step 1: Write the failing tests in `tests/pr-reviewer.test.ts`**

```ts
describe("Structured Severity Classification (#182)", () => {
  it("instructs the reviewer to tag findings with [BLOCKER] or [SUGGESTION]", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/\[BLOCKER\]/);
    expect(content).toMatch(/\[SUGGESTION\]/);
  });

  it("distinguishes between blocking bugs and non-blocking suggestions in summary output", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/classifyReviewFindings|formatStructuredReview/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pr-reviewer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement structured severity tagging and formatting**

In `scripts/pr-reviewer.js`:
Add instructions to `buildSystemPrompt`:
```javascript
`SEVERITY CLASSIFICATION:
Classify any reported finding into:
- [BLOCKER]: Demonstrable runtime crash, data corruption, verified security exploit, or severe regression.
- [SUGGESTION]: Non-blocking observation, minor cleanup, or optional test enhancement.
If there are no BLOCKER items, clearly state that the PR is safe to merge.`
```

Implement `formatStructuredReview(rawReview)`:
- Groups findings into Blockers vs Suggestions.
- Adds an executive summary banner (Approved ✅ vs Changes Requested 🛑).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pr-reviewer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/pr-reviewer.js tests/pr-reviewer.test.ts
git commit -m "feat(pr-reviewer): add structured severity tagging and formatting"
```

---

### Task 3: Self-Correction Verification / Reflection Step

**Files:**
- Modify: `scripts/pr-reviewer.js:280-360`
- Test: `tests/pr-reviewer.test.ts`

**Interfaces:**
- Consumes: `rawContent: string, runtimeContext: string, apiKey: string`
- Produces: `verifyReviewFindings(rawContent: string, runtimeContext: string): Promise<string>`

- [ ] **Step 1: Write the failing tests in `tests/pr-reviewer.test.ts`**

```ts
describe("Self-Correction Verification Filter (#182)", () => {
  it("defines a verification filter that purges false positive findings", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/verifyReviewFindings|filterFalsePositives/);
    expect(content).toMatch(/PR_REVIEW_VERIFY/);
  });

  it("filters out invalid thread-safety claims on Node.js code", () => {
    const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
    const content = fs.readFileSync(scriptPath, "utf8");

    expect(content).toMatch(/thread\s*safety/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pr-reviewer.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `filterFalsePositives` and `verifyReviewFindings` in `scripts/pr-reviewer.js`**

Implement deterministic regex and rule-based false positive scrubbing + optional second-pass reflection:
1. Strip any finding flagging "thread safety" or "concurrent access" on standard Node.js in-memory structures when `runtimeContext` is Node.js.
2. If all findings are stripped or downgraded, replace with a clean "LGTM: No blocking defects found."

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pr-reviewer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/pr-reviewer.js tests/pr-reviewer.test.ts
git commit -m "feat(pr-reviewer): add verification filter to purge runtime hallucinations"
```

---

### Task 4: Full Test Suite & MegaLinter Verification

**Files:**
- Test: `tests/pr-reviewer.test.ts`, all repo tests

- [ ] **Step 1: Run TypeScript typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All 66 test suites passing (912+ tests)

- [ ] **Step 3: Run cspell check**

Run: `npx cspell -c .cspell.json scripts/pr-reviewer.js tests/pr-reviewer.test.ts`
Expected: 0 spelling errors

- [ ] **Step 4: Commit any test adjustments**

```bash
git add -A
git commit -m "chore(pr-reviewer): finalize test suite and spellcheck verification"
```
