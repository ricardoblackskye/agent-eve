import { type NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { isStoryTrigger } from "../../../../agent/lib/story-trigger";

interface RepoConfig {
  webhook_secret_env: string;
  token_env: string;
  release_notes_path: string;
}

interface ManagerConfig {
  repos: Record<string, RepoConfig>;
  defaults: RepoConfig;
}

let cachedConfig: ManagerConfig | null = null;

function loadConfig(): ManagerConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = path.join(process.cwd(), "release-manager.config.json");
  const raw = fs.readFileSync(configPath, "utf-8");
  cachedConfig = JSON.parse(raw) as ManagerConfig;
  return cachedConfig;
}

function getRepoConfig(repoFullName: string): RepoConfig | null {
  try {
    const config = loadConfig();
    return config.repos[repoFullName] || null;
  } catch {
    return null;
  }
}

/**
 * True when the app is running as a PRODUCTION deployment.
 *
 * Used to decide whether a missing webhook secret is a fatal
 * misconfiguration rather than a local convenience.
 *
 * Deliberately production-only: Preview deployments have no webhook secret
 * configured, and the preview eval suite posts unsigned webhooks at them.
 * Failing closed on Preview broke that suite without adding security — a
 * preview URL sits behind Vercel's protection bypass and holds no production
 * data. If a secret IS configured on preview, it is still enforced.
 */
function isProductionEnvironment(): boolean {
  return process.env.VERCEL_ENV === "production";
}

/**
 * Verify the x-hub-signature-256 against the webhook secret.
 * Returns true if the signature is valid, or if no secret is configured and
 * we are NOT in a deployed environment (local development only).
 */
function verifySignature(
  payload: string,
  signatureHeader: string | null,
  secret: string | undefined,
): boolean {
  // An unset secret historically returned true, which silently accepted
  // forged payloads on any deployment that forgot GH_WEBHOOK_SECRET.
  // In a deployed environment that is a fatal misconfiguration: fail closed.
  if (!secret) {
    if (isProductionEnvironment()) {
      return false;
    }
    return true; // Local development and preview only.
  }
  if (!signatureHeader) return false;

  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${sig}` === signatureHeader;
}

async function handler(request: NextRequest) {
  // Only accept POST requests
  if (request.method !== "POST") {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }

  const payload = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  const event = request.headers.get("x-github-event");

  if (!event) {
    return NextResponse.json(
      { error: "Missing x-github-event header" },
      { status: 400 },
    );
  }

  // Handle ping event early (does not require repository or signature)
  if (event === "ping") {
    return NextResponse.json({ ok: true, message: "pong" });
  }

  // Parse the payload
  let data: any;
  try {
    data = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // For pull_request events, check PR data early so empty bodies get a
  // clear "No PR data" error rather than a misleading "Missing repository".
  if (event === "pull_request" && !data.pull_request) {
    return NextResponse.json({ error: "No PR data" }, { status: 400 });
  }

  // Look up repo config
  const repoFullName: string =
    data.repository?.full_name || data.repository?.fullName || "";

  if (!repoFullName) {
    return NextResponse.json(
      { error: "Missing repository full_name in payload" },
      { status: 400 },
    );
  }

  const repoConfig = getRepoConfig(repoFullName);
  if (!repoConfig) {
    return NextResponse.json(
      {
        error: `Unknown repo '${repoFullName}'. Add it to release-manager.config.json to enable webhook processing.`,
      },
      { status: 404 },
    );
  }

  // Validate signature with the per-repo secret.
  // A missing secret in a deployed environment is a misconfiguration, not a
  // signature failure: surface it as a 500 with an explicit message so it is
  // distinguishable from a genuine bad signature (401) in the delivery logs.
  const webhookSecret = process.env[repoConfig.webhook_secret_env];
  if (!webhookSecret && isProductionEnvironment()) {
    console.error(
      `[webhook] ${repoConfig.webhook_secret_env} is not set in a deployed environment ` +
        `(VERCEL_ENV=${process.env.VERCEL_ENV}). Refusing to process the webhook without ` +
        `signature verification. Set the secret in your Vercel environment variables.`,
    );
    return NextResponse.json(
      {
        ok: false,
        error:
          `Webhook secret '${repoConfig.webhook_secret_env}' is not configured in this ` +
          `deployment. Refusing to process an unverified webhook.`,
      },
      { status: 500 },
    );
  }

  if (!verifySignature(payload, signature, webhookSecret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // We process pull_request events
  if (event === "pull_request") {
    const action = data.action; // opened, synchronize, closed, etc.
    const pr = data.pull_request;
    const repo = data.repository;

    if (!pr) {
      return NextResponse.json({ error: "No PR data" }, { status: 400 });
    }

    const prData = {
      number: pr.number,
      title: pr.title,
      body: pr.body || "",
      state: pr.state,
      merged: pr.merged,
      mergedBy: pr.merged_by?.login || null,
      url: pr.html_url,
      action,
      repo: repo?.full_name || data.repository?.full_name,
      labels: (pr.labels || []).map((l: any) => l.name),
      baseBranch: pr.base?.ref,
      headBranch: pr.head?.ref,
    };

    // Build a release-notes task message for the Eve agent
    const message = [
      `Generate release notes for a PR change:`,
      ``,
      `Repository: ${prData.repo}`,
      `PR #${prData.number} (${prData.action}): ${prData.title}`,
      prData.body ? `Description: ${prData.body.slice(0, 500)}` : "",
      `Labels: ${prData.labels.join(", ") || "none"}`,
      `Base branch: ${prData.baseBranch}`,
      `Head branch: ${prData.headBranch}`,
      ``,
      `Update releasenotes.md with a new entry for this change.`,
    ]
      .filter(Boolean)
      .join("\n");

    // Call the Eve API to trigger the Release Manager subagent.
    //
    // IMPORTANT (bug #39): If the Eve API session call fails, we must NOT
    // return HTTP 200 `{"ok: true}`. A 200 tells GitHub the webhook was
    // delivered successfully, so GitHub won't retry or surface the failure —
    // and releasenotes.md is silently never written. We map the upstream
    // failure to a 502 (Bad Gateway) with `ok: false` so the failure is
    // observable in GitHub's webhook delivery logs and the Release Manager is
    // not invoked until its dependency is healthy.
    let eveApiResult = "skipped";
    let eveApiError: string | null = null;
    let eveApiStatus: number | null = null;
    const apiKey = process.env.EVE_API_KEY;

    try {
      const targetUrl = `${request.nextUrl.origin}/eve/v1/session`;
      const apiHeaders: Record<string, string> = {
        "content-type": "application/json",
      };
      if (apiKey) {
        apiHeaders.authorization = `Bearer ${apiKey}`;
      }
      const bypass =
        process.env.VERCEL_PROTECTION_BYPASS ||
        request.headers.get("x-vercel-protection-bypass") ||
        request.nextUrl.searchParams.get("x-vercel-protection-bypass");
      if (bypass) {
        apiHeaders["x-vercel-protection-bypass"] = bypass;
      }
      const cookie = request.headers.get("cookie");
      if (cookie) {
        apiHeaders["cookie"] = cookie;
      }

      const apiResponse = await fetch(targetUrl, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ message }),
      });

      if (apiResponse.ok) {
        const apiData = await apiResponse.json();
        eveApiResult = apiData?.status || "accepted";
      } else {
        eveApiStatus = apiResponse.status;
        let detail = "";
        try {
          const errData = await apiResponse.json();
          detail = errData?.error || errData?.message || apiResponse.statusText;
        } catch {
          detail = apiResponse.statusText;
        }
        eveApiResult = `error: ${apiResponse.status}`;
        eveApiError = `Eve API rejected session: ${detail}`;
      }
    } catch (err) {
      eveApiError = err instanceof Error ? err.message : String(err);
      eveApiResult = "error";
      console.error(`[webhook] Eve API call failed: ${eveApiError}`);
    }

    console.log(
      `[webhook] PR #${prData.number} ${action}: ${prData.title} — Eve API: ${eveApiResult}`,
    );

    // Surface upstream failures instead of masking them as a success.
    if (eveApiResult.startsWith("error")) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Eve API session creation failed; release notes were not updated.",
          eveApiResult,
          ...(eveApiError ? { eveApiError } : {}),
          ...(eveApiStatus ? { eveApiStatus } : {}),
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      message: `PR #${prData.number} ${action} acknowledged`,
      pr: prData,
      eveApiResult,
      ...(eveApiError ? { eveApiError } : {}),
    });
  }

  // Handle issue events that ask the Product Owner subagent to draft a story.
  if (event === "issues") {
    const action = data.action; // opened, edited, reopened, labeled, closed, ...
    const issue = data.issue;

    // Detect the trigger (mention in body, or the trigger label) using the
    // shared, platform-neutral detector. Non-triggering issues fall through.
    if (
      !isStoryTrigger({
        action,
        issue: {
          number: issue?.number,
          title: issue?.title,
          body: issue?.body || "",
          labels: (issue?.labels || []).map((l: any) => ({ name: l.name })),
        },
        label: data.label ? { name: data.label.name } : undefined,
      })
    ) {
      return NextResponse.json({
        ok: true,
        message: `Issue ${issue?.number} ${action} received but is not a story trigger`,
      });
    }

    // Build a Product Owner task message for the Eve agent.
    const owner = repoFullName.split("/")[0];
    const repo = repoFullName.split("/")[1];
    const message = [
      `Draft a user story from this GitHub issue:`,
      ``,
      `Repository: ${repoFullName}`,
      `Issue #${issue?.number} (${action}): ${issue?.title}`,
      issue?.body ? `Description: ${issue.body.slice(0, 2000)}` : "",
      ``,
      `Steps:`,
      `1. Call draft_user_story with the request above.`,
      `2. If it returns status "needs_clarification", call comment_questions with ` +
        `owner "${owner}", repo "${repo}", issueNumber ${issue?.number}, and the questions — then STOP.`,
      `3. If it returns status "complete", call publish_story with ` +
        `provider: "github", sourceIssueNumber: ${issue?.number}, and the returned payload ` +
        `so a linked [Story] issue is created on GitHub. Do NOT use the console dry-run default.`,
    ]
      .filter(Boolean)
      .join("\n");

    let eveApiResult = "skipped";
    let eveApiError: string | null = null;
    let eveApiStatus: number | null = null;
    const apiKey = process.env.EVE_API_KEY;

    try {
      const targetUrl = `${request.nextUrl.origin}/eve/v1/session`;
      const apiHeaders: Record<string, string> = {
        "content-type": "application/json",
      };
      if (apiKey) {
        apiHeaders.authorization = `Bearer ${apiKey}`;
      }
      const bypass =
        process.env.VERCEL_PROTECTION_BYPASS ||
        request.headers.get("x-vercel-protection-bypass") ||
        request.nextUrl.searchParams.get("x-vercel-protection-bypass");
      if (bypass) {
        apiHeaders["x-vercel-protection-bypass"] = bypass;
      }
      const cookie = request.headers.get("cookie");
      if (cookie) {
        apiHeaders["cookie"] = cookie;
      }

      const apiResponse = await fetch(targetUrl, {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({ message }),
      });

      if (apiResponse.ok) {
        const apiData = await apiResponse.json();
        eveApiResult = apiData?.status || "accepted";
      } else {
        eveApiStatus = apiResponse.status;
        let detail = "";
        try {
          const errData = await apiResponse.json();
          detail = errData?.error || errData?.message || apiResponse.statusText;
        } catch {
          detail = apiResponse.statusText;
        }
        eveApiResult = `error: ${apiResponse.status}`;
        eveApiError = `Eve API rejected session: ${detail}`;
      }
    } catch (err) {
      eveApiError = err instanceof Error ? err.message : String(err);
      eveApiResult = "error";
      console.error(`[webhook] Eve API call failed: ${eveApiError}`);
    }

    console.log(
      `[webhook] Issue #${issue?.number} ${action}: ${issue?.title} — Eve API: ${eveApiResult}`,
    );

    if (eveApiResult.startsWith("error")) {
      return NextResponse.json(
        {
          ok: false,
          error: "Eve API session creation failed; the story was not drafted.",
          eveApiResult,
          ...(eveApiError ? { eveApiError } : {}),
          ...(eveApiStatus ? { eveApiStatus } : {}),
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      message: `Issue #${issue?.number} ${action} acknowledged by Product Owner`,
      eveApiResult,
      ...(eveApiError ? { eveApiError } : {}),
    });
  }

  // Heartbeat / ping from GitHub
  if (event === "ping") {
    return NextResponse.json({ ok: true, message: "pong" });
  }

  // Unhandled event type
  return NextResponse.json(
    { ok: true, message: `Event '${event}' received but not processed` },
    { status: 200 },
  );
}

export const POST = handler;
export const GET = handler;
