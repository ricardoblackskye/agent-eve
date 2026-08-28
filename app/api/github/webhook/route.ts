import { type NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs";
import path from "path";

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
 * Verify the x-hub-signature-256 against the webhook secret.
 * Returns true if the signature is valid or no secret is configured.
 */
function verifySignature(
  payload: string,
  signatureHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!secret) return true; // Skip verification if no secret configured (dev only)
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

  // Validate signature with the per-repo secret
  const webhookSecret = process.env[repoConfig.webhook_secret_env];
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

    // Call the Eve API to trigger the Release Manager subagent
    let eveApiResult = "skipped";
    let eveApiError: string | null = null;
    const apiKey = process.env.EVE_API_KEY;

    try {
      const targetUrl = `${request.nextUrl.origin}/eve/v1/session`;
      const apiHeaders: Record<string, string> = {
        "content-type": "application/json",
      };
      if (apiKey) {
        apiHeaders.authorization = `Bearer ${apiKey}`;
      }
      const bypass = process.env.VERCEL_PROTECTION_BYPASS;
      if (bypass) {
        apiHeaders[`x-vercel-protection-bypass`] = bypass;
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
        eveApiResult = `error: ${apiResponse.status}`;
      }
    } catch (err) {
      eveApiError = err instanceof Error ? err.message : String(err);
      eveApiResult = "error";
      console.error(`[webhook] Eve API call failed: ${eveApiError}`);
    }

    console.log(
      `[webhook] PR #${prData.number} ${action}: ${prData.title} — Eve API: ${eveApiResult}`,
    );

    return NextResponse.json({
      ok: true,
      message: `PR #${prData.number} ${action} acknowledged`,
      pr: prData,
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
