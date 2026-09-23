import fs from "fs";
import {
  isTransientModelError,
  parseRetryAfter,
  retryDelayMs,
  RETRY_DEFAULTS,
} from "./pr-reviewer-retry";

// NOTE: the reviewer deliberately does NOT use the project's default model —
// that default is a REASONING model, which is the #87 root cause. See REVIEW_MODEL
// below for the measured evidence.
interface PullRequestPayload {
  number: number;
  diff_url: string;
  base: { repo: { owner: { login: string }; name: string } };
}

interface GitHubEvent {
  pull_request?: PullRequestPayload;
  issue?: { number: number; pull_request?: unknown };
  repository?: { owner: { login: string }; name: string };
}

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error("GITHUB_EVENT_PATH environment variable is not set.");
  process.exit(1);
}

let event: GitHubEvent;
try {
  const eventContent = fs.readFileSync(eventPath, "utf8"); // Synchronous is acceptable at startup
  event = JSON.parse(eventContent) as GitHubEvent;
} catch (error) {
  console.error("Failed to read or parse GitHub event:", error);
  process.exit(1);
}

// Extract PR information
let prNumber: number;
let repoOwner: string;
let repoName: string;
let prDiffUrl: string;

if (event.pull_request) {
  prNumber = event.pull_request.number;
  repoOwner = event.pull_request.base.repo.owner.login;
  repoName = event.pull_request.base.repo.name;
  prDiffUrl = event.pull_request.diff_url;
} else if (event.issue && event.issue.pull_request) {
  // Handle issue events that are actually PRs (like labeled, etc.)
  prNumber = event.issue.number;
  repoOwner = event.repository!.owner.login;
  repoName = event.repository!.name;
  // We need to get the diff URL from the API or construct it
  prDiffUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}.diff`;
} else {
  console.error("Event does not contain pull request information:", event);
  process.exit(1);
}

console.log(`Processing PR #${prNumber} in ${repoOwner}/${repoName}`);

// Fetch the PR diff
let prDiff: string;
try {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  const diffResponse = await fetch(prDiffUrl, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3.diff",
      "User-Agent": "agent-eve-pr-reviewer/1.0",
    },
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!diffResponse.ok) {
    throw new Error(
      `Failed to fetch diff: ${diffResponse.status} ${diffResponse.statusText}`,
    );
  }

  prDiff = await diffResponse.text();
  console.log(`Fetched diff of length ${prDiff.length}`);
} catch (error) {
  console.error("Error fetching PR diff:", error);
  process.exit(1);
}

// Documentation has no review value for a code reviewer, and it dominates
// large diffs: a single 70KB markdown plan pushed one PR past 100KB, which
// made the reasoning model exhaust its token budget and return null content.
// Drop documentation-only files before spending any of that budget.
const NON_CODE_PATTERNS = [
  /\.mdx?$/i,
  /(^|\/)docs?\//i,
  /(^|\/)LICENSE(\.md)?$/i,
  /(^|\/)\.hermes\/plans\//i,
];

function stripDocsFromDiff(diff: string): {
  diff: string;
  removedBytes: number;
  removedFiles: string[];
} {
  const parts = diff.split(/(?=^diff --git )/m);
  const kept = [];
  const removedFiles = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const match = part.match(/^diff --git a\/(.+?) b\//m);
    const filePath = match ? match[1] : "";
    if (filePath && NON_CODE_PATTERNS.some((p) => p.test(filePath))) {
      removedFiles.push(filePath);
      continue;
    }
    kept.push(part);
  }
  const stripped = kept.join("");
  return {
    diff: stripped,
    removedBytes: diff.length - stripped.length,
    removedFiles,
  };
}

const {
  diff: codeDiff,
  removedBytes,
  removedFiles,
} = stripDocsFromDiff(prDiff);

if (removedFiles.length > 0) {
  console.log(
    `Excluded ${removedFiles.length} documentation file(s) from review ` +
      `(${removedBytes} bytes): ${removedFiles.join(", ")}`,
  );
}

// Reasoning models (e.g. deepseek-v4.1-flash) spend part of the completion
// budget on a separate `reasoning` field before emitting any answer, and their
// reasoning length is NON-DETERMINISTIC. `effort` is only a HINT: with a 4k
// budget the model spent ALL of it thinking and returned null `content` on an
// HTTP 200 (finish_reason: "length"), so every review silently degraded to the
// structural stub (#87). Two guards:
//   1. HARD-cap the reasoning tokens so the answer always has room, and
//   2. RETRY once with a smaller diff if the budget is still exhausted.
// Input is also kept small: docs are stripped, and the diff is capped here.
const MAX_DIFF_CHARS = Number(process.env.PR_REVIEW_MAX_DIFF_CHARS) || 20000;

// Total completion budget, and the slice reasoning must not exceed. max_tokens
// has to comfortably exceed the reasoning cap so a full review still fits after
// the model finishes thinking.
const REVIEW_MAX_TOKENS = Number(process.env.PR_REVIEW_MAX_TOKENS) || 6000;
const REVIEW_REASONING_MAX_TOKENS =
  Number(process.env.PR_REVIEW_REASONING_MAX_TOKENS) || 1500;

// #87 ROOT CAUSE: the project default (deepseek/deepseek-v4.1-flash) is a
// REASONING model, and its chain-of-thought can consume the ENTIRE completion
// budget, leaving no content to post. Measured against the live API on a 14k-char
// diff, it returned finish_reason="length" with ZERO content:
//   - reasoning.max_tokens=1500 -> ~22.6k chars of reasoning (cap IGNORED)
//   - reasoning.effort="low"    -> ~32.5k chars of reasoning (hint IGNORED)
//   - no reasoning param        -> ~23.6k chars of reasoning
// Reasoning also GROWS with max_tokens (~40k chars at max_tokens=32000), so
// raising the budget only moves the wall — no fixed budget is safe. A
// NON-reasoning model cannot fail this way: it answered in ~30s with
// finish_reason="stop" every time, and it tolerates the reasoning block below.
// Override with PR_REVIEW_MODEL if you want a reasoning model here, and raise
// PR_REVIEW_MAX_TOKENS well above its observed reasoning length.
const REVIEW_MODEL = process.env.PR_REVIEW_MODEL || "deepseek/deepseek-chat";

function truncateDiff(
  diff: string,
  maxChars: number,
): { diff: string; truncated: boolean; omitted: number } {
  if (diff.length <= maxChars) return { diff, truncated: false, omitted: 0 };

  const kept = diff.slice(0, maxChars);
  // Cut on a line boundary so the model never sees a half-written hunk.
  const lastBreak = kept.lastIndexOf("\n");
  const cut = lastBreak > 0 ? kept.slice(0, lastBreak) : kept;
  return { diff: cut, truncated: true, omitted: diff.length - cut.length };
}

const {
  diff: reviewDiff,
  truncated,
  omitted,
} = truncateDiff(codeDiff, MAX_DIFF_CHARS);

if (truncated) {
  console.log(
    `Diff truncated for review: ${codeDiff.length} -> ${reviewDiff.length} chars (${omitted} omitted)`,
  );
}

/**
 * Escape a diff for safe interpolation into the prompt: backslashes FIRST, then
 * backticks. Order matters — escaping backticks alone leaves a preceding
 * backslash able to escape the escaping backslash, i.e. incomplete escaping
 * (CodeQL flags exactly this). One canonical sanitiser, used by both attempts.
 */
function sanitizeForPrompt(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

// Sanitize PR diff to prevent prompt injection (escape backslashes, then backticks)
const sanitizedPrDiff = sanitizeForPrompt(reviewDiff);

/**
 * Detect runtime environment from diff filenames to provide targeted runtime context.
 */
function detectRuntimeEnvironment(diff: string): string {
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

function buildSystemPrompt(runtimeContext: string): string {
  return [
    `You are a pragmatic principal software engineer reviewing this code diff.`,
    `Target Runtime Environment: ${runtimeContext}`,
    ``,
    `CRITICAL REVIEW GUIDELINES:`,
    `1. HIGH PRECISION OVER HIGH RECALL: Only report concrete, demonstrable bugs, actual security vulnerabilities, or severe logic defects. If the diff is clean, sound, and defect-free, explicitly output "LGTM" and do NOT fabricate minor or subjective feedback.`,
    `2. RUNTIME ACCURACY: For Node.js/JavaScript, the runtime executes on a single-threaded event loop. Do NOT flag "thread safety" or concurrent memory corruption on standard in-memory JavaScript data structures (Set, Map, Array, Object).`,
    `3. VERIFY BEFORE ASSERTING: Check if a capability is already provided. For example, if constructor options or parameter objects allow injecting dependencies or options, do NOT claim Dependency Injection or configurability is missing.`,
    `4. DO NOT NITPICK OR DICTATE TASTE: Do not flag subjective architectural preferences (e.g. debating Singleton vs Factory vs Registry) unless it causes an actual memory leak or unhandled exception. Avoid bike-shedding on patterns that provide reasonable encapsulation for the scope of the PR.`,
    `5. SEVERITY CLASSIFICATION: Classify any reported findings into:`,
    `   - [BLOCKER]: Demonstrable runtime crash, data corruption, verified security exploit, or severe regression.`,
    `   - [SUGGESTION]: Non-blocking observation, minor cleanup, or optional test enhancement.`,
    `   If there are no BLOCKER items, clearly state that the PR is safe to merge.`,
    `6. EXACT CITATIONS: You MUST reference the exact line numbers from the diff headers (@@ -x,y +a,b @@) for any reported defect.`,
  ].join("\n");
}

/**
 * Format raw review content into clean, structured markdown with severity indicators.
 */
function formatStructuredReview(rawReview: string): string {
  if (!rawReview || typeof rawReview !== "string") {
    return rawReview;
  }

  const trimmed = rawReview.trim();
  const hasBlockers = /\[BLOCKER\]/i.test(trimmed);
  const isLgtm = /\bLGTM\b/i.test(trimmed) && !hasBlockers;

  const header = isLgtm
    ? "## 🤖 Automated PR Review — Approved (LGTM) ✅"
    : hasBlockers
      ? "## 🤖 Automated PR Review — Changes Requested 🛑"
      : "## 🤖 Automated PR Review — Comments & Suggestions 💡";

  return [header, "", trimmed].join("\n");
}

/**
 * Filter known false-positive hallucination patterns from raw review output.
 */
function filterFalsePositives(content: string, runtimeContext: string): string {
  if (!content || typeof content !== "string") return content;

  let filtered = content;
  const isNode = /node\.js|typescript|javascript/i.test(runtimeContext);

  if (isNode) {
    // 1. Scrub invalid multi-threading / thread-safety claims on single-threaded Node.js runtimes
    const threadSafetyPattern =
      /(?:[-*•]\s*)?(?:\[(?:BLOCKER|SUGGESTION)\]\s*)?[^\n]*(?:thread[- ]safety|multi-threaded|race condition on (?:Set|Map|Array|in-memory))[^\n]*(?:\n\s{2,}[^\n]+)*/gi;
    filtered = filtered.replace(threadSafetyPattern, "");
  }

  // 2. Clean up empty blocks or dangling headers
  filtered = filtered.replace(/\n{3,}/g, "\n\n").trim();

  // 3. If all complaints were purged or the review is now empty, convert to clean LGTM
  if (
    !filtered ||
    filtered === "LGTM" ||
    (!/\[BLOCKER\]/i.test(filtered) &&
      !/(?:error|vulnerability|defect|bug|risk)/i.test(filtered))
  ) {
    return "LGTM: No blocking defects or runtime anti-patterns detected. Code is sound and ready to merge.";
  }

  return filtered;
}

const ENABLE_VERIFY = process.env.PR_REVIEW_VERIFY !== "0";

const RUNTIME_CONTEXT = detectRuntimeEnvironment(reviewDiff);
const SYSTEM_PROMPT = buildSystemPrompt(RUNTIME_CONTEXT);

/**
 * Assemble the user message for one attempt.
 *
 * `sanitizedDiff` is the ESCAPED text sent to the model; `keptLength` is the
 * un-escaped length of the diff we actually kept. The truncation note must report
 * the real size — escaping adds backslashes, so using `${sanitizedDiff.length}`
 * overstates it (found in the AI review of PR #149). Extracted so the retry path
 * reuses one prompt builder.
 */
function buildUserMessage(
  sanitizedDiff: string,
  wasTruncated: boolean,
  omittedChars: number,
  keptLength: number,
): string {
  const excludedNote =
    removedFiles.length > 0
      ? `\n\nNote: ${removedFiles.length} documentation file(s) were excluded (${removedFiles.join(", ")}).`
      : "";
  const truncationNote = wasTruncated
    ? `\n\nNote: this diff was truncated to ${keptLength} of ${codeDiff.length} characters (${omittedChars} omitted). Review what is shown; do not speculate about the omitted part.`
    : "";
  return `Please review the following diff and provide your feedback with specific line number citations:${excludedNote}${truncationNote}\n\n\`\`\`diff\n${sanitizedDiff}\n\`\`\``;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MAX_ATTEMPTS =
  Number(process.env.PR_REVIEW_MAX_ATTEMPTS) || RETRY_DEFAULTS.maxAttempts;
const OPENROUTER_TIMEOUT_MS = Number(process.env.PR_REVIEW_TIMEOUT_MS) || 90000;
const PROVIDER_SORT = (process.env.PR_REVIEW_PROVIDER_SORT || "").trim();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST to OpenRouter, retrying TRANSIENT failures (#191): HTTP 429/5xx and
 * network/timeout errors, with exponential backoff (+ jitter), honouring
 * Retry-After. Non-transient responses (e.g. 400/401/403) are returned at once
 * so the caller surfaces the real cause instead of looping. Adds a request
 * timeout so a hung provider cannot stall the job.
 */
async function postCompletion(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const request: RequestInit = {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  };
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= OPENROUTER_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, request);
      if (res.ok || !isTransientModelError({ status: res.status })) return res;
      lastError = new Error(`HTTP ${res.status}`);
      if (attempt === OPENROUTER_MAX_ATTEMPTS) return res;
      const delay = retryDelayMs(attempt, {
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
      console.warn(
        `OpenRouter ${res.status}; retrying in ${delay}ms (attempt ${attempt + 1}/${OPENROUTER_MAX_ATTEMPTS}).`,
      );
      await sleep(delay);
    } catch (err) {
      lastError = err;
      if (attempt === OPENROUTER_MAX_ATTEMPTS) throw err;
      const delay = retryDelayMs(attempt);
      console.warn(
        `OpenRouter request failed (${err instanceof Error ? err.message : String(err)}); retrying in ${delay}ms (attempt ${attempt + 1}/${OPENROUTER_MAX_ATTEMPTS}).`,
      );
      await sleep(delay);
    }
  }
  throw lastError ?? new Error("OpenRouter request failed");
}

// Call OpenRouter API to generate review, with fallback for rate limits
let review: string;
try {
  const openrouterResponse = await postCompletion(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: REVIEW_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: buildUserMessage(
              sanitizedPrDiff,
              truncated,
              omitted,
              reviewDiff.length,
            ),
          },
        ],
        temperature: 0.2,
        // HARD cap on reasoning tokens. OpenRouter allows only ONE of
        // `reasoning.effort` / `reasoning.max_tokens` per request (sending both
        // returns HTTP 400), so we send the cap: `effort` is only a hint the
        // model may exceed, and reasoning length is non-deterministic (0, ~5.5k,
        // ~17k tokens for the same diff). max_tokens must comfortably exceed it.
        reasoning: { max_tokens: REVIEW_REASONING_MAX_TOKENS },
        max_tokens: REVIEW_MAX_TOKENS,
        ...(PROVIDER_SORT ? { provider: { sort: PROVIDER_SORT } } : {}),
      }),
    },
  );

  console.log(`OpenRouter response status: ${openrouterResponse.status}`);

  let content = "";
  let finishReason = "unknown";
  let fallbackReason = "the model did not return a review";

  if (!openrouterResponse.ok) {
    const errorText = await openrouterResponse.text();
    console.warn(
      `OpenRouter call failed (${openrouterResponse.status}). Response: ${errorText}`,
    );
    fallbackReason = `the model API returned HTTP ${openrouterResponse.status}`;
  } else {
    const openrouterData = await openrouterResponse.json();
    const choice = openrouterData.choices?.[0];
    const message = choice?.message;

    if (message && message.content) {
      content = message.content;
    } else {
      // A null-content success is usually the reasoning budget: the model put
      // its whole completion budget into `reasoning` and never answered.
      finishReason = choice?.finish_reason ?? "unknown";
      const reasoning = message?.reasoning;
      console.warn(
        `OpenRouter returned no message content (finish_reason: ${finishReason}, reasoning length: ${
          typeof reasoning === "string" ? reasoning.length : 0
        })`,
      );
    }
  }

  // #87: a length-exhausted response is NOT an outage — the model spent its
  // whole output budget reasoning. RETRY once with a smaller diff (reasoning
  // pressure scales with input) instead of immediately posting the stub.
  const retry = truncateDiff(codeDiff, Math.floor(MAX_DIFF_CHARS / 2));
  // Halving the diff is the retry's only lever: if the diff already fits within
  // half the cap, the "retry" would send an IDENTICAL payload and exhaust the
  // same budget — skip the wasted call and fall through to the fallback with a
  // cause-accurate reason (raised in the AI review of PR #149).
  const retryWouldBeIdentical = retry.diff === reviewDiff;

  if (!content && finishReason === "length" && retryWouldBeIdentical) {
    console.warn(
      "Skipping retry: the diff already fits in half the cap, so the retry would send an identical payload (#87).",
    );
    fallbackReason =
      "the model spent its entire output budget on internal reasoning and emitted no answer";
  }

  if (!content && finishReason === "length" && !retryWouldBeIdentical) {
    console.warn(
      "Reasoning exhausted the token budget; retrying with a smaller diff (#87).",
    );

    const retryResponse = await postCompletion(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: REVIEW_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: buildUserMessage(
                sanitizeForPrompt(retry.diff),
                retry.truncated,
                retry.omitted,
                retry.diff.length,
              ),
            },
          ],
          temperature: 0.2,
          reasoning: { max_tokens: REVIEW_REASONING_MAX_TOKENS },
          max_tokens: REVIEW_MAX_TOKENS,
          ...(PROVIDER_SORT ? { provider: { sort: PROVIDER_SORT } } : {}),
        }),
      },
    );
    console.log(`OpenRouter retry response status: ${retryResponse.status}`);

    if (retryResponse.ok) {
      const retryData = await retryResponse.json();
      content = retryData.choices?.[0]?.message?.content ?? "";
    }
    if (content) {
      console.log(`Generated review of length ${content.length} (retry)`);
    } else {
      fallbackReason =
        "the model spent its entire output budget on internal reasoning and emitted no answer, even after a retry with a smaller diff";
    }
  } else if (!content && finishReason !== "length") {
    // Do NOT clobber the specific length-exhausted reason set above when the
    // retry was skipped — otherwise the comment misreports the cause (bug found
    // in the AI review of PR #149).
    fallbackReason = "the model returned no review content";
  }

  if (content) {
    const verifiedContent = ENABLE_VERIFY
      ? filterFalsePositives(content, RUNTIME_CONTEXT)
      : content;
    review = formatStructuredReview(verifiedContent);
    console.log(`Generated review of length ${review.length}`);
  } else {
    review = generateFallbackReview(
      prNumber,
      repoOwner,
      repoName,
      prDiff,
      fallbackReason,
    );
  }
} catch (error) {
  console.error(`Error calling OpenRouter: ${(error as Error).message}`);
  review = generateFallbackReview(
    prNumber,
    repoOwner,
    repoName,
    prDiff,
    `a transport error (${(error as Error).message})`,
  );
}

// Generate a deterministic fallback review when the model produced no content.
// `reason` carries the REAL cause (reasoning budget exhausted vs a transport
// error) so the comment stops blaming a model outage that never happened (#87).
function generateFallbackReview(
  number: number,
  owner: string,
  repo: string,
  diff: string,
  reason: string,
): string {
  const lineCount = diff.split("\n").length;
  const addedLines = diff
    .split("\n")
    .filter((l: string) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removedLines = diff
    .split("\n")
    .filter((l: string) => l.startsWith("-") && !l.startsWith("---")).length;
  const filesChanged = (diff.match(/diff --git/g) || []).length;

  return [
    "## Automated PR Review (Structural Fallback)",
    "",
    `> ⚠️ The AI review could not be completed: ${reason}. This is a structural review only — please review manually.`,
    "",
    `**PR #${number}** in \`${owner}/${repo}\``,
    "",
    "### Summary",
    `- Files changed: ${filesChanged || "N/A"}`,
    `- Lines added: ${addedLines}`,
    `- Lines removed: ${removedLines}`,
    `- Total diff lines: ${lineCount}`,
    "",
    "### Checklist",
    "- [ ] No secrets or credentials committed",
    "- [ ] Error handling covers edge cases",
    "- [ ] Tests added for new behavior",
    "- [ ] Documentation updated if needed",
    "- [ ] No breaking changes to public APIs",
    "",
    "Please review the points above manually.",
  ].join("\n");
}

// Post the review as a comment on the PR
try {
  const commentResponse = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: review }),
    },
  );

  if (!commentResponse.ok) {
    const errorText = await commentResponse.text();
    throw new Error(
      `Failed to post comment: ${commentResponse.status} ${commentResponse.statusText}\nResponse: ${errorText}`,
    );
  }

  const result = await commentResponse.json();
  console.log(`Posted comment: ${result.html_url}`);
} catch (error) {
  console.error("Error posting comment:", error);
  process.exit(1);
}

console.log("PR reviewer completed successfully.");
