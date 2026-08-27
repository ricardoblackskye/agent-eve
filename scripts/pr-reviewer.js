import fs from 'fs';

// Read the GitHub event payload
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  console.error("GITHUB_EVENT_PATH environment variable is not set.");
  process.exit(1);
}

let event;
try {
  const eventContent = fs.readFileSync(eventPath, 'utf8'); // Synchronous is acceptable at startup
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
      Accept: 'application/vnd.github.v3.diff',
      'User-Agent': 'agent-eve-pr-reviewer/1.0',
    },
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (!diffResponse.ok) {
    throw new Error(`Failed to fetch diff: ${diffResponse.status} ${diffResponse.statusText}`);
  }

  prDiff = await diffResponse.text();
  console.log(`Fetched diff of length ${prDiff.length}`);
} catch (error) {
  console.error("Error fetching PR diff:", error);
  process.exit(1);
}

// Sanitize PR diff to prevent prompt injection (escape backticks)
const sanitizedPrDiff = prDiff.replace(/`/g, '\\`');

// Call OpenRouter API to generate review
let review;
try {
  const openrouterResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
          content: "You are a senior software engineer reviewing this code diff. Look for architectural anti-patterns, security risks, and off-by-one errors. You MUST reference the exact line numbers from the diff headers (@@ -x,y +a,b @@) in your feedback.",
        },
        {
          role: "user",
          content: `Please review the following diff and provide your feedback with specific line number citations:\n\n\`\`\`diff\n${sanitizedPrDiff}\n\`\`\``,
        },
      ],
      temperature: 0.2,
      max_tokens: 1500,
    }),
  });

  console.log(`OpenRouter response status: ${openrouterResponse.status}`);

  if (!openrouterResponse.ok) {
    const errorText = await openrouterResponse.text();
    throw new Error(`Failed to call OpenRouter: ${openrouterResponse.status} ${openrouterResponse.statusText}\nResponse: ${errorText}`);
  }

  const openrouterData = await openrouterResponse.json();
  console.log(`OpenRouter response data:`, openrouterData);
  
  if (!openrouterData.choices || openrouterData.choices.length === 0) {
    throw new Error(`No choices in OpenRouter response: ${JSON.stringify(openrouterData)}`);
  }

  // Validate response before accessing content
  if (!openrouterData.choices[0].message || !openrouterData.choices[0].message.content) {
    throw new Error(`Invalid response format from OpenRouter: missing message or content`);
  }

  review = openrouterData.choices[0].message.content;
  console.log(`Generated review of length ${review.length}`);
} catch (error) {
  console.error("Error generating review:", error);
  process.exit(1);
}

// Handle large diffs by truncating if necessary (though we already sent the full diff,
// we could add a note if it was very large)
if (prDiff.length > 100000) {
  console.log(`Warning: PR diff was large (${prDiff.length} bytes), consider implementing summarization for very large PRs`);
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
    const errorText = await commentResponse.text();
    throw new Error(`Failed to post comment: ${commentResponse.status} ${commentResponse.statusText}\nResponse: ${errorText}`);
  }

  const result = await commentResponse.json();
  console.log(`Posted comment: ${result.html_url}`);
} catch (error) {
  console.error("Error posting comment:", error);
  process.exit(1);
}

console.log("PR reviewer completed successfully.");