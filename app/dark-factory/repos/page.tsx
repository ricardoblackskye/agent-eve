import type { ReactNode } from "react";

import { resolveWorkerAllowedRepos } from "../../../agent/lib/dark-factory/credentials";
import { readinessOf } from "../../../agent/lib/dark-factory/amm-scoring";
import {
  defaultAmmProvider,
  listedRepos,
} from "../../../agent/lib/dark-factory/amm-readiness";
import { RepoList } from "../ui/repo-list";

export const dynamic = "force-dynamic";

export const metadata = { title: "Repositories" };

/**
 * #413 (epic #403 R1) — the repositories the Dark Factory is working on.
 *
 * The config is read through the SAME resolver the worker uses, so the page and the worker cannot disagree about
 * which repos are in scope; the scan arrives through the `AmmReadinessProvider` seam, which is the fixture until the
 * AMM scanner exists.
 */
export default async function ReposPage(): Promise<ReactNode> {
  const configured = resolveWorkerAllowedRepos(process.env).join(",");
  const rows = await listedRepos({ configured, provider: defaultAmmProvider() });
  return <RepoList readiness={readinessOf(rows)} rows={rows} />;
}
