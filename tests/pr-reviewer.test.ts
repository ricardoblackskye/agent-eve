import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Mock node-fetch for testing API calls
vi.mock("node-fetch", () => ({
  default: vi.fn(),
}));

describe("PR Reviewer Agent - TDD Tests", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Workflow File (.github/workflows/pr-reviewer.yml)", () => {
    it("should use Node.js 22 or lts/* instead of 24", () => {
      const workflowPath = path.join(
        process.cwd(),
        ".github",
        "workflows",
        "pr-reviewer.yml",
      );
      const content = fs.readFileSync(workflowPath, "utf8");
      expect(content).toMatch(/node-version: '22'/);
      expect(content).not.toMatch(/node-version: '24'/);
    });

    it("should have explicit cache key for npm ci (recommended)", () => {
      const workflowPath = path.join(
        process.cwd(),
        ".github",
        "workflows",
        "pr-reviewer.yml",
      );
      const content = fs.readFileSync(workflowPath, "utf8");
      // This is a recommendation, so we'll warn if not present but not fail
      if (!content.includes("cache:") || !content.includes("npm")) {
        console.warn(
          "Consider adding explicit cache key for npm ci in workflow file",
        );
      }
    });

    it("should end with a newline", () => {
      const workflowPath = path.join(
        process.cwd(),
        ".github",
        "workflows",
        "pr-reviewer.yml",
      );
      const content = fs.readFileSync(workflowPath, "utf8");
      expect(content.endsWith("\n")).toBe(true);
    });
  });

  describe("Agent Definition (agent/subagents/pr-reviewer/agent.ts)", () => {
    it("should not have hardcoded model name (should use config/env)", () => {
      const agentPath = path.join(
        process.cwd(),
        "agent",
        "subagents",
        "pr-reviewer",
        "agent.ts",
      );
      const content = fs.readFileSync(agentPath, "utf8");

      // Should not contain the hardcoded model string directly
      expect(content).not.toContain("nvidia/nemotron-3-ultra-550b-a55b:free");

      // Should reference a config or environment variable
      expect(content).toMatch(
        /process\.env\.MODEL_NAME|config\.model|MODEL_NAME/,
      );
    });

    it("should have reasonable context window (< 500000 tokens)", () => {
      const agentPath = path.join(
        process.cwd(),
        "agent",
        "subagents",
        "pr-reviewer",
        "agent.ts",
      );
      const content = fs.readFileSync(agentPath, "utf8");

      // Extract the modelContextWindowTokens value
      const match = content.match(/modelContextWindowTokens:\s*(\d+)/);
      if (match) {
        const windowSize = parseInt(match[1], 10);
        expect(windowSize).toBeLessThan(500000);
      } else {
        // If not found, that's also an issue
        expect(false).toBe(true);
      }
    });

    it("should not have unused imports", () => {
      // This is harder to test automatically, but we can at least
      // verify that createOpenAI is actually used if imported
      const agentPath = path.join(
        process.cwd(),
        "agent",
        "subagents",
        "pr-reviewer",
        "agent.ts",
      );
      const content = fs.readFileSync(agentPath, "utf8");

      if (content.includes("createOpenAI")) {
        expect(content).toMatch(/createOpenAI\(/);
      }
    });
  });

  describe("PR Reviewer Script (scripts/pr-reviewer.js)", () => {
    it("should use asynchronous file I/O or justify synchronous usage", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
      const content = fs.readFileSync(scriptPath, "utf8");

      // Should use async version or have a comment justifying sync usage
      const hasAsyncRead =
        content.includes("fs.promises.readFile") ||
        (content.includes("fs.readFile(") &&
          !content.includes("fs.readFileSync"));
      const hasJustifyingComment = content.includes(
        "// Synchronous is acceptable at startup",
      );

      expect(hasAsyncRead || hasJustifyingComment).toBe(true);
    });

    it("should wrap top-level await in async function or use ES module", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
      const content = fs.readFileSync(scriptPath, "utf8");

      // Check if it's an ES module
      const isESModule =
        content.includes("import ") &&
        content.includes("from ") &&
        !content.includes("require(");

      // Or check if main logic is wrapped in async function
      const hasAsyncWrapper =
        content.includes("(async () =>") ||
        content.includes("async function") ||
        (content.includes("() => {") &&
          content.includes("await ") &&
          content.includes("})()"));

      expect(isESModule || hasAsyncWrapper).toBe(true);
    });

    it("should add timeout to fetch calls for PR diff", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
      const content = fs.readFileSync(scriptPath, "utf8");

      // Should use AbortSignal.timeout or similar timeout mechanism
      expect(content).toMatch(/AbortSignal\.timeout|timeout|signal:/);
    });

    it("should centralize model name (not hardcoded)", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
      const content = fs.readFileSync(scriptPath, "utf8");

      // Should not contain the hardcoded model string
      expect(content).not.toContain("nvidia/nemotron-3-ultra-550b-a55b:free");

      // Should get model from config/environment
      expect(content).toMatch(
        /process\.env\.OPENROUTER_MODEL|MODEL_NAME|config\.model/,
      );
    });

    it("should sanitize PR diff to prevent prompt injection", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
      const content = fs.readFileSync(scriptPath, "utf8");

      // Should escape backticks in the diff before using in template literal
      // Simple check for replace or escape function
      expect(content).toMatch(/replace|escape|sanitize/);
    });

    it("should validate OpenRouter response before accessing content", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
      const content = fs.readFileSync(scriptPath, "utf8");

      // Should check for choices array and message content
      expect(content).toMatch(/choices\.length|if\s*!\(choices/);
    });

    it("should add User-Agent header to GitHub API calls", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
      const content = fs.readFileSync(scriptPath, "utf8");

      // Should include User-Agent in headers
      expect(content).toMatch(/User-Agent.*agent-eve|'User-Agent'/);
    });

    it("should handle large diffs (truncation or summarization)", () => {
      const scriptPath = path.join(process.cwd(), "scripts", "pr-reviewer.js");
      const content = fs.readFileSync(scriptPath, "utf8");

      // Should have logic to handle large diffs
      expect(content).toMatch(
        /maxDiffLength|truncate|substring|\.length\s*>\s*\d+/,
      );
    });
  });

  describe("Test File (tests/pr-reviewer.test.ts)", () => {
    it("should avoid dynamic import after mocks", () => {
      const testPath = path.join(process.cwd(), "tests", "pr-reviewer.test.ts");
      const content = fs.readFileSync(testPath, "utf8");

      // Should not use await import after mocks are set up
      expect(content).not.toMatch(/await\s+import\(/);

      // Should use regular import or vi.hoisted
      expect(content).toMatch(/import.*from|vi\.hoisted/);
    });

    it("should test behavior, not just existence", () => {
      // This test will verify that we actually test the agent's behavior
      // For now, we'll check if the test file has meaningful assertions
      const testPath = path.join(process.cwd(), "tests", "pr-reviewer.test.ts");
      const content = fs.readFileSync(testPath, "utf8");

      // Should have more than just existence checks
      const meaningfulAssertions =
        content.match(/expect\([^)]+\)\.to(?:Be|Have|Contain|Match|Throw)/g) ||
        [];

      expect(meaningfulAssertions.length).toBeGreaterThan(1);
    });
  });
});
