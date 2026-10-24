import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createAmmScanStore } from "../../../../../agent/lib/dark-factory/amm-scan-provider";
import { toStoredScan } from "../../../../../agent/lib/dark-factory/amm-scan-store";
import { scoreRepo } from "../../../../../agent/lib/dark-factory/amm-scoring";

// The route guards with resolveViewer; we don't stand up a session here, so the guard is satisfied.
vi.mock("../../../../../app/api/dark-factory/viewer", () => ({
  resolveViewer: async () => ({ ok: true, viewer: { email: "t@example.com", role: "operator" } }),
}));

const directories: string[] = [];
const closable: { close(): void }[] = [];

beforeAll(() => {
  process.env.DF_WORKER_ALLOWED_REPOS = "ricardoblackskye/agent-eve";
});

afterAll(() => {
  for (const store of closable.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * #465 - the detail page reads the readiness scan across a server boundary (it is a client component, like the runs
 * board). This handler is that boundary. It reads the configured store and refuses rather than fabricating when no
 * store is set, mirroring the fail-closed decision recorded for #424 and applied to the list page.
 */
describe("GET /api/dark-factory/amm-scans (T4)", () => {
  it("returns the measured scan the store holds for the repo", async () => {
    const directory = mkdtempSync(join(tmpdir(), "df-amm-api-"));
    directories.push(directory);
    const dbPath = join(directory, "scans.sqlite");
    vi.stubEnv("DF_AMM_SCAN_DRIVER", "sqlite");
    vi.stubEnv("DF_AMM_SCAN_DB_PATH", dbPath);

    const store = createAmmScanStore({ DF_AMM_SCAN_DRIVER: "sqlite", DF_AMM_SCAN_DB_PATH: dbPath });
    closable.push(store);
    const written = await store.recordScan(
      toStoredScan(
        scoreRepo({ repo: "ricardoblackskye/WebFeedPOC", measurements: {}, scannedAt: "2026-10-25T00:00:00.000Z" }),
      ),
    );
    expect(written.ok).toBe(true);

    const { GET } = await import("../../../../../app/api/dark-factory/amm-scans/route");
    const res = await GET(
      new NextRequest("http://localhost/api/dark-factory/amm-scans?repo=ricardoblackskye/WebFeedPOC"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scan: { repo: string } | null };
    // The store normalizes the repo, so the lookup is case-insensitive.
    expect(body.scan?.repo).toBe("ricardoblackskye/webfeedpoc");
  });

  it("returns 400 when no repo is supplied", async () => {
    vi.stubEnv("DF_AMM_SCAN_DRIVER", "sqlite");
    vi.stubEnv("DF_AMM_SCAN_DB_PATH", join(mkdtempSync(join(tmpdir(), "df-amm-api-")), "x.sqlite"));
    const { GET } = await import("../../../../../app/api/dark-factory/amm-scans/route");
    const res = await GET(new NextRequest("http://localhost/api/dark-factory/amm-scans"));
    expect(res.status).toBe(400);
  });

  it("REFUSES rather than fabricating when no store is configured", async () => {
    vi.unstubAllEnvs();
    delete process.env.DF_AMM_SCAN_DRIVER;
    const { GET } = await import("../../../../../app/api/dark-factory/amm-scans/route");
    const res = await GET(
      new NextRequest("http://localhost/api/dark-factory/amm-scans?repo=ricardoblackskye/agent-eve"),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/DF_AMM_SCAN_DRIVER/);
  });
});
