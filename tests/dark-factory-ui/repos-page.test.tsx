// @vitest-environment jsdom
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ReposPage from "../../app/dark-factory/repos/page";
import { createAmmScanStore } from "../../agent/lib/dark-factory/amm-scan-provider";
import { toStoredScan, type AmmScanStore } from "../../agent/lib/dark-factory/amm-scan-store";
import { scoreRepo } from "../../agent/lib/dark-factory/amm-scoring";

const directories: string[] = [];
const closable: { close(): void }[] = [];

afterEach(async () => {
  for (const store of closable.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

/** Point the page at a temp sqlite store, and hand back the path so a scan can be put in it. */
function storeEnv(): string {
  const directory = mkdtempSync(join(tmpdir(), "df-amm-page-"));
  directories.push(directory);
  const dbPath = join(directory, "scans.sqlite");
  vi.stubEnv("DF_AMM_SCAN_DRIVER", "sqlite");
  vi.stubEnv("DF_AMM_SCAN_DB_PATH", dbPath);
  return dbPath;
}

async function recordScanFor(repo: string, dbPath: string): Promise<void> {
  const store: AmmScanStore = createAmmScanStore({
    DF_AMM_SCAN_DRIVER: "sqlite",
    DF_AMM_SCAN_DB_PATH: dbPath,
  });
  closable.push(store);
  const written = await store.recordScan(
    toStoredScan(scoreRepo({ repo, measurements: {}, scannedAt: "2026-10-25T00:00:00.000Z" })),
  );
  expect(written.ok).toBe(true);
}

/**
 * #413 (epic #403 R1) — the page, not just the rule; #465 — the page reads the MEASURED scan.
 *
 * The page reads the runner's allowed-repo setting through the SAME resolver the worker uses, so these tests
 * drive it from the environment rather than from an injected list. #465 changed what the scan half points at:
 * the page used to render a hard-coded fixture of `agent-eve`, and now renders what the store holds. The first
 * test therefore asserts the REVERSE of the old expectation — the repo a scan was recorded for is listed, and
 * the fixture's repo is not — which is what proves the fixture is gone.
 */
describe("Dark Factory repos page", () => {
  it("lists a configured repo from the MEASURED scan, not the fixture", async () => {
    const dbPath = storeEnv();
    vi.stubEnv(
      "DF_WORKER_ALLOWED_REPOS",
      "ricardoblackskye/agent-eve,ricardoblackskye/WebFeedPOC",
    );
    await recordScanFor("ricardoblackskye/WebFeedPOC", dbPath);

    render(await ReposPage());

    const link = screen.getByText("ricardoblackskye/WebFeedPOC");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "/dark-factory/repos/ricardoblackskye/WebFeedPOC",
    );
    // The fixture's repo is configured but has no scan in the store, so it is NOT listed.
    expect(screen.queryByText("ricardoblackskye/agent-eve")).toBeNull();
  });

  it("says why the list is empty when nothing has been scanned", async () => {
    storeEnv();
    vi.stubEnv("DF_WORKER_ALLOWED_REPOS", "ricardoblackskye/WebFeedPOC");

    render(await ReposPage());

    expect(
      screen.getByText(/no configured repository has a readiness scan yet/i),
    ).toBeTruthy();
  });

  it("REFUSES to render rather than fall back to a fixture when no store is configured", async () => {
    vi.stubEnv("DF_WORKER_ALLOWED_REPOS", "ricardoblackskye/agent-eve");

    await expect(ReposPage()).rejects.toThrow(/DF_AMM_SCAN_DRIVER/);
  });
});
