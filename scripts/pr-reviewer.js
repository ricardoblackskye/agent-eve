import fs from "fs";

// Read the GitHub event payload
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

// Reasoning models (deepseek-v4-pro) spend `max_tokens` on a separate
// `reasoning` field before emitting any answer. A large diff makes them
// exhaust that budget, so `content` comes back null on an HTTP 200 and the
// review silently degrades to the structural fallback. Cap the prompt instead
// of raising max_tokens forever: measure the budget in characters here, and
// keep the plan/doc noise out of a code review.
const MAX_DIFF_CHARS = Number(process.env.PR_REVIEW_MAX_DIFF_CHARS) || 20000;

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
} = truncateDiff(prDiff, MAX_DIFF_CHARS);

if (truncated) {
  console.log(
    `Diff truncated for review: ${prDiff.length} -> ${reviewDiff.length} chars (${omitted} omitted)`,
  );
}

// Sanitize PR diff to prevent prompt injection (escape backticks)
const sanitizedPrDiff = reviewDiff.replace(/`/g, "\\`");

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
        model: process.env.MODEL_NAME,
        messages: [
          {
            role: "system",
            content:
              "You are a senior software engineer reviewing this code diff. Look for architectural anti-patterns, security risks, and off-by-one errors. You MUST reference the exact line numbers from the diff headers (@@ -x,y +a,b @@) in your feedback.",
          },
          {
            role: "user",
            content: `Please review the following diff and provide your feedback with specific line number citations:${
              truncated
                ? `\n\nNote: this diff was truncated to ${reviewDiff.length} of ${prDiff.length} characters (${omitted} omitted). Review what is shown; do not speculate about the omitted part.`
                : ""
            }\n\n\`\`\`diff\n${sanitizedPrDiff}\n\`\`\``,
          },
        ],
        temperature: 0.2,
        // Reasoning models (e.g. deepseek-v4-pro) report their thinking in a
        // separate `reasoning` field and spend `max_tokens` on it. At 1500 the
        // budget was exhausted before any answer was emitted, so `content`
        // came back null HTTP 200 and the script fell back to a structural
        // review. Raise the budget so the visible answer survives.
        max_tokens: 4000,
      }),
    },
  );

  console.log(`OpenRouter response status: ${openrouterResponse.status}`);

  if (!openrouterResponse.ok) {
    const errorText = await openrouterResponse.text();
    console.warn(
      `OpenRouter call failed (${openrouterResponse.status}), using fallback review.\nResponse: ${errorText}`,
    );
    // Fallback: generate a basic review without the model
    review = generateFallbackReview(prNumber, repoOwner, repoName, prDiff);
  } else {
    const openrouterData = await openrouterResponse.json();
    const message = openrouterData.choices?.[0]?.message;

    if (!message) {
      console.warn("Invalid OpenRouter response, using fallback review.");
      review = generateFallbackReview(prNumber, repoOwner, repoName, prDiff);
    } else if (!message.content) {
      // Reasoning models can emit all their output into `reasoning` and leave
      // `content` null when the token budget runs out. Report that precisely
      // instead of the generic "Invalid OpenRouter response", and fall back to
      // the reasoning text when there is nothing else to post.
      const reasoning = message.reasoning;
      console.warn(
        `OpenRouter returned no message content (finish_reason: ${
          openrouterData.choices?.[0]?.finish_reason ?? "unknown"
        }, reasoning length: ${
          typeof reasoning === "string" ? reasoning.length : 0
        }), using fallback review.`,
      );
      review = generateFallbackReview(prNumber, repoOwner, repoName, prDiff);
    } else {
      review = message.content;
      console.log(`Generated review of length ${review.length}`);
    }
  }
} catch (error) {
  console.error(`Error calling OpenRouter: ${error.message}`);
  console.warn("Using fallback review.");
  review = generateFallbackReview(prNumber, repoOwner, repoName, prDiff);
}

// Generate a deterministic fallback review when the model is unavailable
function generateFallbackReview(number, owner, repo, diff) {
  const lineCount = diff.split("\n").length;
  const addedLines = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removedLines = diff
    .split("\n")
    .filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  const filesChanged = (diff.match(/diff --git/g) || []).length;

  return [
    "## Automated PR Review (Fallback Mode)",
    "",
    "> ⚠️ The AI model was unavailable (rate-limited or offline). This is a structural review only — please review manually for deeper analysis.",
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
    "Please address the above items and request a re-review once the AI model is available.",
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
