import type { ReactNode } from "react";

import { resolveWorkerAllowedRepos } from "../../../agent/lib/dark-factory/credentials";
import { readinessOf } from "../../../agent/lib/dark-factory/amm-scoring";
import { ammProviderFromEnv } from "../../../agent/lib/dark-factory/amm-scan-provider";
import { listedRepos } from "../../../agent/lib/dark-factory/amm-readiness";
import { RepoList } from "../ui/repo-list";

export const dynamic = "force-dynamic";

export const metadata = { title: "Repositories" };

/**
 * #413 (epic #403 R1) — the repositories the Dark Factory is working on. #465 — the scan is MEASURED.
 *
 * The config is read through the SAME resolver the worker uses, so the page and the worker cannot disagree about
 * which repos are in scope. The scan arrives through the `AmmReadinessProvider` seam, and since #465 that seam is
 * the configured scan store: a page that cannot measure refuses rather than rendering a fixture, which is the
 * fail-closed decision already recorded for #424.
 */
export default async function ReposPage(): Promise<ReactNode> {
  const configured = resolveWorkerAllowedRepos(process.env).join(",");
  const provider = ammProviderFromEnv();
  try {
    const rows = await listedRepos({ configured, provider });
    return <RepoList readiness={readinessOf(rows)} rows={rows} />;
  } finally {
    // The page created the store, so the page releases it: a server render that leaked a handle per request would
    // only show up in production, against the deployed driver.
    provider.close?.();
  }
}
