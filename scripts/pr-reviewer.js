import fs from "fs";

// Default model for the PR-review LLM call. Mirrors agent/model-config.ts so the
// script and the agent stay on the same default. Falls back to this when
// MODEL_NAME is unset (previously it sent `undefined`, which OpenRouter rejects).
const DEFAULT_MODEL_ID = "deepseek/deepseek-v4.1-flash";
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error("GITHUB_EVENT_PATH environment variable is not set.");
  process.exit(1);
}

let event;
try {
  const eventContent = fs.readFileSync(eventPath, "utf8"); // Synchronous is acceptable at startup
  event = JSON.parse(eventContent);
} catch (error) {
  console.error("Failed to read or parse GitHub event:", error);
  process.exit(1);
}

// Extract PR information
let prNumber;
let repoOwner;
let repoName;
let prDiffUrl;

if (event.pull_request) {
  prNumber = event.pull_request.number;
  repoOwner = event.pull_request.base.repo.owner.login;
  repoName = event.pull_request.base.repo.name;
  prDiffUrl = event.pull_request.diff_url;
} else if (event.issue && event.issue.pull_request) {
  // Handle issue events that are actually PRs (like labeled, etc.)
  prNumber = event.issue.number;
  repoOwner = event.repository.owner.login;
  repoName = event.repository.name;
  // We need to get the diff URL from the API or construct it
  prDiffUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/pulls/${prNumber}.diff`;
} else {
  console.error("Event does not contain pull request information:", event);
  process.exit(1);
}

console.log(`Processing PR #${prNumber} in ${repoOwner}/${repoName}`);

// Fetch the PR diff
let prDiff;
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

function stripDocsFromDiff(diff) {
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

function truncateDiff(diff, maxChars) {
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
function sanitizeForPrompt(text) {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}

// Sanitize PR diff to prevent prompt injection (escape backslashes, then backticks)
const sanitizedPrDiff = sanitizeForPrompt(reviewDiff);

const SYSTEM_PROMPT =
  "You are a senior software engineer reviewing this code diff. Look for architectural anti-patterns, security risks, and off-by-one errors. You MUST reference the exact line numbers from the diff headers (@@ -x,y +a,b @@) in your feedback.";

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
  sanitizedDiff,
  wasTruncated,
  omittedChars,
  keptLength,
) {
  const excludedNote =
    removedFiles.length > 0
      ? `\n\nNote: ${removedFiles.length} documentation file(s) were excluded (${removedFiles.join(", ")}).`
      : "";
  const truncationNote = wasTruncated
    ? `\n\nNote: this diff was truncated to ${keptLength} of ${codeDiff.length} characters (${omittedChars} omitted). Review what is shown; do not speculate about the omitted part.`
    : "";
  return `Please review the following diff and provide your feedback with specific line number citations:${excludedNote}${truncationNote}\n\n\`\`\`diff\n${sanitizedDiff}\n\`\`\``;
}

// Call OpenRouter API to generate review, with fallback for rate limits
let review;
try {
  const openrouterResponse = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.MODEL_NAME || DEFAULT_MODEL_ID,
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
  if (!content && finishReason === "length") {
    console.warn(
      "Reasoning exhausted the token budget; retrying with a smaller diff (#87).",
    );
    const retry = truncateDiff(codeDiff, Math.floor(MAX_DIFF_CHARS / 2));

    const retryResponse = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.MODEL_NAME || DEFAULT_MODEL_ID,
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
  } else if (!content) {
    fallbackReason = "the model returned no review content";
  }

  if (content) {
    review = content;
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
  console.error(`Error calling OpenRouter: ${error.message}`);
  review = generateFallbackReview(
    prNumber,
    repoOwner,
    repoName,
    prDiff,
    `a transport error (${error.message})`,
  );
}

// Generate a deterministic fallback review when the model produced no content.
// `reason` carries the REAL cause (reasoning budget exhausted vs a transport
// error) so the comment stops blaming a model outage that never happened (#87).
function generateFallbackReview(number, owner, repo, diff, reason) {
  const lineCount = diff.split("\n").length;
  const addedLines = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removedLines = diff
    .split("\n")
    .filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
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
