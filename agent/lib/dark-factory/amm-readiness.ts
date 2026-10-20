/**
 * #413 (epic #403 R1) — the AMM readiness seam.
 *
 * "Hooked into the system" = a repository set in the runner's allowed-repo config AND which has had its first AMM
 * readiness scan. The scan arrives through THIS seam so the mocked phase and the real scanner share one contract,
 * and the fixture below carries the current scan of this repository (Level 4 Optimized, 74/100) taken from the
 * whitepaper scan — so the UI is built against real figures rather than an invented shape.
 *
 * The model scores BINARY signals (present or absent, no partial credit). The UI therefore renders what a scan
 * reports and never recomputes a level from signals: a second derivation of the same number can disagree with the
 * scorer, and the scorer is the authority.
 */

/** One binary signal in the model. Level sets its point value: L1 1, L2 2, L3 4, L4 8, L5 16. */
export interface AmmSignal {
  id: string;
  label: string;
  present: boolean;
  level: number;
}

export interface AmmPillar {
  id: number;
  name: string;
  level: number;
  label: string;
  benchmark: string;
  evidence: string[];
  signals?: AmmSignal[];
}

export interface AmmCapability {
  name: string;
  stage: string;
}

export interface AmmScan {
  repo: string;
  scannedAt: string;
  overall: { points: number; maxPoints: number; level: number; label: string };
  pillars: AmmPillar[];
  capabilities: AmmCapability[];
}

/** Where a scan comes from. Two adapters satisfy it: fixture (now) and database (when the scanner exists). */
export interface AmmReadinessProvider {
  scan(repo: string): Promise<AmmScan | undefined>;
}

/** The level bands. Points scale exponentially, and L3 is the production-grade floor. */
export const AMM_LEVELS: readonly { level: number; points: number; label: string }[] = [
  { level: 1, points: 5, label: "Functional" },
  { level: 2, points: 19, label: "Documented" },
  { level: 3, points: 36, label: "Standardized" },
  { level: 4, points: 60, label: "Optimized" },
  { level: 5, points: 100, label: "Software Factory" },
];

/** The whitepaper calls Level 3 "the minimum bar for production-grade autonomous operation". */
export const AMM_FLOOR_LEVEL = 3;

export function normalizeRepo(repo: string): string {
  return repo.trim().toLowerCase();
}

/** Split the runner's allowed-repo setting: comma separated, trimmed, normalized, deduplicated. */
export function parseConfiguredRepos(configured: string): string[] {
  const seen = new Set<string>();
  for (const entry of configured.split(",")) {
    const repo = normalizeRepo(entry);
    if (repo !== "") seen.add(repo);
  }
  return [...seen];
}

/** A scan source backed by a fixed set of scans. The mocked phase, and the shape the scanner will fill. */
export function fixtureAmmProvider(scans: readonly AmmScan[]): AmmReadinessProvider {
  const byRepo = new Map(scans.map((scan) => [normalizeRepo(scan.repo), scan]));
  return {
    async scan(repo: string) {
      return byRepo.get(normalizeRepo(repo));
    },
  };
}

export interface RepoRow {
  repo: string;
  level: number;
  label: string;
}

/**
 * The repos the factory is actually working on: configured AND scanned.
 *
 * A configured repo with no scan is deliberately absent (it is not ready for autonomous work yet), and a scan for a
 * repo that is not configured is ignored — the config is the source of truth for WHICH repos, the scan only says
 * whether one is ready.
 */
export async function listedRepos(input: {
  configured: string;
  provider: AmmReadinessProvider;
}): Promise<RepoRow[]> {
  const rows: RepoRow[] = [];
  for (const repo of parseConfiguredRepos(input.configured)) {
    const scan = await input.provider.scan(repo);
    if (!scan) continue;
    rows.push({ repo, level: scan.overall.level, label: scan.overall.label });
  }
  return rows;
}

/** The headline leadership metric: the share of active repos at the production floor or above. */
export function organizationalReadiness(rows: readonly RepoRow[]): {
  atOrAboveFloor: number;
  active: number;
  pct: number;
} {
  const active = rows.length;
  const atOrAboveFloor = rows.filter((row) => row.level >= AMM_FLOOR_LEVEL).length;
  const pct = active === 0 ? 0 : Math.round((atOrAboveFloor / active) * 100);
  return { atOrAboveFloor, active, pct };
}

const pillar = (id: number, name: string, level: number, extra = ""): AmmPillar => ({
  id,
  name,
  level,
  label: `Level ${level}${extra}`,
  benchmark: "",
  evidence: [],
});

/**
 * The current scan of this repository, transcribed from the whitepaper scan: Level 4 (Optimized), 74/100, clearing
 * the Level 3 floor across all eight pillars. Real figures, so R3's UI is not built against invented data.
 */
export function agentEveScan(): AmmScan {
  return {
    repo: "ricardoblackskye/agent-eve",
    scannedAt: "2026-10-19T00:00:00.000Z",
    overall: { points: 74, maxPoints: 100, level: 4, label: "Level 4 (Optimized)" },
    pillars: [
      pillar(1, "Style & Validation", 4),
      pillar(2, "Build System", 4),
      pillar(3, "Testing", 4, "+"),
      pillar(4, "Documentation & Instructions", 5),
      pillar(5, "Dev Environment & Remote Execution", 4, "+"),
      pillar(6, "Code Quality", 4),
      pillar(7, "Debugging & Observability", 4),
      pillar(8, "Security & Governance", 4.5),
    ],
    capabilities: [
      { name: "Triage & Signal-to-Action", stage: "L4 (Optimized)" },
      { name: "Multi-Agent Orchestration", stage: "L4 (Optimized)" },
      { name: "Guardrail-Enforced Execution", stage: "L4.5 (Advanced)" },
      { name: "Autonomous Code Review", stage: "L4 (Optimized)" },
      { name: "Dynamic Testing & QA", stage: "L4 (Optimized)" },
      { name: "Model Routing", stage: "L4 (Optimized)" },
      { name: "Release & Documentation", stage: "L4+ (Optimized)" },
      { name: "Outcome Measurement", stage: "L4 (Optimized)" },
      { name: "Self-Improving Pipelines", stage: "Early L5 (Frontier)" },
    ],
  };
}

/** The default source until the scanner lands. */
export function defaultAmmProvider(): AmmReadinessProvider {
  return fixtureAmmProvider([agentEveScan()]);
}
