import fs from 'fs';
import { createOpenAI } from "@ai-sdk/openai";

// Read the GitHub event payload
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error("GITHUB_EVENT_PATH environment variable is not set.");
  process.exit(1);
}

let event;
try {
  const eventContent = fs.readFileSync(eventPath, 'utf8');
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
  const diffResponse = await fetch(prDiffUrl, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3.diff',
    },
  });

  if (!diffResponse.ok) {
    throw new Error(`Failed to fetch diff: ${diffResponse.status} ${diffResponse.statusText}`);
  }

  prDiff = await diffResponse.text();
  console.log(`Fetched diff of length ${prDiff.length}`);
} catch (error) {
  console.error("Error fetching PR diff:", error);
  process.exit(1);
}

// Set up OpenRouter client
const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Generate the review using the model with emphasis on line numbers
let review;
try {
  const prompt = `You are a senior software engineer reviewing this code diff. Look for architectural anti-patterns, security risks, and off-by-one errors.
CRITICAL: You MUST reference the exact line numbers from the diff headers (@@ -x,y +a,b @@) in your feedback.
Please review the following diff and provide your feedback with specific line number citations:

\`\`\`diff
${prDiff}
\`\`\``;

  const completion = await openrouter.chatCompletion({
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    messages: [
      { role: "system", content: "You are a senior software engineer reviewing this code diff. Look for architectural anti-patterns, security risks, and off-by-one errors. You MUST reference the exact line numbers from the diff headers (@@ -x,y +a,b @@) in your feedback." },
      { role: "user", content: prompt },
    ],
    temperature: 0.2, // Lower temperature for more focused review
    max_tokens: 1500,
  });

  review = completion.choices[0].message.content;
  console.log(`Generated review of length ${review.length}`);
} catch (error) {
  console.error("Error generating review:", error);
  process.exit(1);
}

// Post the review as a comment on the PR
try {
  const commentResponse = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/issues/${prNumber}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: review }),
    }
  );

  if (!commentResponse.ok) {
    throw new Error(`Failed to post comment: ${commentResponse.status} ${commentResponse.statusText}`);
  }

  const result = await commentResponse.json();
  console.log(`Posted comment: ${result.html_url}`);
} catch (error) {
  console.error("Error posting comment:", error);
  process.exit(1);
}

console.log("PR reviewer completed successfully.");